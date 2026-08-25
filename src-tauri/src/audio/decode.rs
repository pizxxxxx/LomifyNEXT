use std::io::Cursor;
use std::num::NonZero;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rodio::decoder::DecoderError;
use rodio::mixer::Mixer;
use rodio::source::SeekError;
use rodio::{Decoder, Player, Source};
use sha2::{Digest, Sha256};

use crate::audio::analyser::{AnalyserBuffer, AnalyserSource};
use crate::audio::eq::{EqSource, GainSource};
use crate::audio::types::{
    ChannelCount, EqParams, SampleRate, NORMALIZATION_ANALYSIS_SAMPLES,
    NORMALIZATION_BLOCK_SAMPLES, NORMALIZATION_MAX_ATTENUATION_DB, NORMALIZATION_MAX_BOOST_DB,
    NORMALIZATION_TARGET_PEAK, NORMALIZATION_TARGET_RMS,
};

const NORMALIZATION_CACHE_VERSION: u8 = 2;

pub fn is_ogg_opus(bytes: &[u8]) -> bool {
    // OpusHead appears at byte 28 in a standard OGG Opus header page
    bytes.len() >= 36
        && &bytes[0..4] == b"OggS"
        && bytes[..bytes.len().min(64)]
            .windows(8)
            .any(|w| w == b"OpusHead")
}

struct OpusSource<R: std::io::Read + std::io::Seek> {
    reader: ogg::reading::PacketReader<R>,
    decoder: audiopus::coder::Decoder,
    channels: ChannelCount,
    buffer: Vec<f32>,
    buf_pos: usize,
    serial: u32,
    pre_skip: usize,
    samples_skipped: usize,
}

impl OpusSource<Cursor<Vec<u8>>> {
    fn new(data: Vec<u8>) -> Result<Self, String> {
        Self::from_reader(Cursor::new(data))
    }
}

impl<R: std::io::Read + std::io::Seek> OpusSource<R> {
    fn from_reader(reader: R) -> Result<Self, String> {
        let mut reader = ogg::reading::PacketReader::new(reader);

        let head_pkt = reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?
            .ok_or("No OpusHead packet")?;

        let head = &head_pkt.data;
        if head.len() < 19 || &head[..8] != b"OpusHead" {
            return Err("Invalid OpusHead".into());
        }

        let serial = head_pkt.stream_serial();
        let ch_count = head[9];
        let pre_skip = u16::from_le_bytes([head[10], head[11]]) as usize;
        let opus_ch = if ch_count == 1 {
            audiopus::Channels::Mono
        } else {
            audiopus::Channels::Stereo
        };

        reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?;

        let decoder = audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch)
            .map_err(|e| format!("Opus decoder error: {:?}", e))?;

        let channel_count = if ch_count == 1 { 1u16 } else { 2u16 };

        Ok(Self {
            reader,
            decoder,
            channels: NonZero::new(channel_count).unwrap(),
            buffer: Vec::new(),
            buf_pos: 0,
            serial,
            pre_skip: pre_skip * channel_count as usize,
            samples_skipped: 0,
        })
    }

    fn decode_next_packet(&mut self) -> bool {
        loop {
            match self.reader.read_packet() {
                Ok(Some(pkt)) => {
                    if pkt.data.is_empty() {
                        continue;
                    }
                    let channels = self.channels.get() as usize;
                    let mut buf = vec![0f32; 5760 * channels];
                    match self.decoder.decode_float(Some(&pkt.data), &mut buf, false) {
                        Ok(samples_per_ch) => {
                            let total = samples_per_ch * channels;
                            buf.truncate(total);

                            if self.samples_skipped < self.pre_skip {
                                let skip = (self.pre_skip - self.samples_skipped).min(total);
                                self.samples_skipped += skip;
                                if skip >= total {
                                    continue;
                                }
                                self.buffer = buf[skip..].to_vec();
                            } else {
                                self.buffer = buf;
                            }
                            self.buf_pos = 0;
                            return true;
                        }
                        Err(_) => continue,
                    }
                }
                _ => return false,
            }
        }
    }
}

impl<R: std::io::Read + std::io::Seek> Iterator for OpusSource<R> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.buf_pos >= self.buffer.len() && !self.decode_next_packet() {
            return None;
        }
        let sample = self.buffer[self.buf_pos];
        self.buf_pos += 1;
        Some(sample)
    }
}

impl<R: std::io::Read + std::io::Seek> Source for OpusSource<R> {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        NonZero::new(48000).unwrap()
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let target_gp = (pos.as_secs_f64() * 48000.0) as u64;

        match self.reader.seek_absgp(Some(self.serial), target_gp) {
            Ok(_) => {
                let opus_ch = if self.channels.get() == 1 {
                    audiopus::Channels::Mono
                } else {
                    audiopus::Channels::Stereo
                };
                self.decoder =
                    audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch).map_err(
                        |_| SeekError::NotSupported {
                            underlying_source: "opus decoder reinit failed",
                        },
                    )?;
                self.buffer.clear();
                self.buf_pos = 0;
                self.samples_skipped = self.pre_skip;
                Ok(())
            }
            Err(_) => Err(SeekError::NotSupported {
                underlying_source: "ogg seek failed",
            }),
        }
    }
}

/// Декодер symphonia поверх байтов трека — с длиной данных и правом перематывать поток.
///
/// `Decoder::new` не сообщает ни того, ни другого: `byte_len` остаётся `None`, а
/// `is_seekable` — `false`. Для mp3 это незаметно, а для mp4 решает всё. Таблица сэмплов
/// (`moov`) лежит в файле либо перед данными, либо после них: первое — результат прогона
/// через `+faststart`, второе — обычный порядок, в котором mp4 пишется по умолчанию. Именно
/// такие файлы отдаёт раздача Яндекс Музыки. Не имея права вернуться назад, symphonia не
/// может пропустить `mdat`, дочитать `moov` в конце и вернуться к данным — и отвечает «формат
/// не распознан» на совершенно исправный файл.
///
/// Снаружи это выглядело как «трек не играет, только короткий звук в начале»: поток
/// напрямую не заводился, зато тот же трек из кэша играл целиком — потому что в кэш он
/// попадает после ремукса ffmpeg с `+faststart`, то есть с `moov` впереди. Предпросмотр в
/// WebView играл по той же причине: Chromium читает mp4 сам и умеет ходить по файлу.
///
/// Заодно появляется честный `total_duration` (без длины файла symphonia не считает
/// длительность) и работающая перемотка внутри декодера.
pub(crate) fn build_symphonia_decoder(
    bytes: &[u8],
) -> Result<Decoder<Cursor<Vec<u8>>>, DecoderError> {
    Decoder::builder()
        .with_data(Cursor::new(bytes.to_vec()))
        .with_byte_len(bytes.len() as u64)
        .with_seekable(true)
        .build()
}

fn normalization_cache_file(cache_dir: &Path, cache_key: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    cache_dir.join(format!("{hash}.gain"))
}

fn read_cached_normalization_gain(
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Option<f32> {
    let path = normalization_cache_file(cache_dir?, cache_key?);
    let raw = std::fs::read_to_string(path).ok()?;
    let (version, value) = raw.trim().split_once(':')?;
    if version != NORMALIZATION_CACHE_VERSION.to_string() {
        return None;
    }
    value.parse::<f32>().ok()
}

fn write_cached_normalization_gain(cache_dir: Option<&Path>, cache_key: Option<&str>, gain: f32) {
    let Some(cache_dir) = cache_dir else {
        return;
    };
    let Some(cache_key) = cache_key else {
        return;
    };

    if std::fs::create_dir_all(cache_dir).is_err() {
        return;
    }

    let path = normalization_cache_file(cache_dir, cache_key);
    let _ = std::fs::write(path, format!("{NORMALIZATION_CACHE_VERSION}:{gain:.6}"));
}

fn normalization_gain_from_samples<I>(samples: I) -> f32
where
    I: IntoIterator<Item = f32>,
{
    let mut peak = 0.0f64;
    let mut count = 0usize;
    let mut block_sum_sq = 0.0f64;
    let mut block_count = 0usize;
    let mut block_powers = Vec::new();

    for sample in samples.into_iter().take(NORMALIZATION_ANALYSIS_SAMPLES) {
        let value = sample as f64;
        let abs = value.abs();
        peak = peak.max(abs);
        block_sum_sq += value * value;
        block_count += 1;
        count += 1;

        if block_count >= NORMALIZATION_BLOCK_SAMPLES {
            block_powers.push(block_sum_sq / block_count as f64);
            block_sum_sq = 0.0;
            block_count = 0;
        }
    }

    if block_count > 0 {
        block_powers.push(block_sum_sq / block_count as f64);
    }

    if count == 0 {
        return 1.0;
    }

    if block_powers.is_empty() {
        return 1.0;
    }

    block_powers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep_from = ((block_powers.len() as f64) * 0.4).floor() as usize;
    let kept = &block_powers[keep_from.min(block_powers.len().saturating_sub(1))..];
    let gated_power = kept.iter().copied().sum::<f64>() / kept.len() as f64;
    let rms = gated_power.sqrt().max(1e-6);
    let target_gain = NORMALIZATION_TARGET_RMS / rms;
    let peak_safe_gain = if peak > 0.0 {
        NORMALIZATION_TARGET_PEAK / peak
    } else {
        target_gain
    };

    let max_boost = 10f64.powf(NORMALIZATION_MAX_BOOST_DB / 20.0);
    let max_attenuation = 10f64.powf(NORMALIZATION_MAX_ATTENUATION_DB / 20.0);
    let gain = target_gain
        .min(peak_safe_gain)
        .clamp(max_attenuation, max_boost);

    if (gain - 1.0).abs() < 0.05 {
        1.0
    } else {
        gain as f32
    }
}

pub fn resolve_normalization_gain(
    bytes: &[u8],
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Result<f32, String> {
    if let Some(gain) = read_cached_normalization_gain(cache_dir, cache_key) {
        return Ok(gain);
    }

    let gain = if is_ogg_opus(bytes) {
        normalization_gain_from_samples(
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    } else if let Ok(source) = build_symphonia_decoder(bytes) {
        normalization_gain_from_samples(source)
    } else {
        normalization_gain_from_samples(
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    };

    write_cached_normalization_gain(cache_dir, cache_key, gain);
    Ok(gain)
}

/// Собранный плеер и всё, что удалось узнать о потоке при сборке.
///
/// Поля кроме `player` нужны не логике, а логу: когда трек «не играет», разницу между
/// «декодер взял файл, но отдал полсекунды» и «поток не дошёл до устройства» видно только
/// по этим числам, а больше их взять негде — источник уезжает внутрь цепочки при `append`.
pub struct PreparedPlayer {
    pub player: Player,
    pub duration_secs: Option<f64>,
    /// Кто разобрал байты: `symphonia`, `opus(ogg)` или `opus(fallback)`.
    pub decoder: &'static str,
    pub sample_rate: u32,
    pub channels: u16,
}

pub fn create_player_from_bytes(
    bytes: &[u8],
    mixer: &Mixer,
    volume: f32,
    normalization_gain: f32,
    start_paused: bool,
    eq_params: Arc<RwLock<EqParams>>,
    analyser_buffer: Arc<AnalyserBuffer>,
) -> Result<PreparedPlayer, String> {
    let player = Player::connect_new(mixer);
    player.set_volume(volume);
    if start_paused {
        player.pause();
    }

    // Build the decoder exactly once. The previous shape probed with
    // `Decoder::new(..).is_ok()` and then built a second one, so every symphonia
    // track paid two full container probes and two whole-file `to_vec()` copies
    // (~2x the track size in transient allocations on every load/seek/reload).
    let (duration_secs, decoder, sample_rate, channels) = if is_ogg_opus(bytes) {
        let source =
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?;
        let about = (
            source.total_duration().map(|d| d.as_secs_f64()),
            "opus(ogg)",
            source.sample_rate().get(),
            source.channels().get(),
        );
        player.append(AnalyserSource::new(
            EqSource::new(GainSource::new(source, normalization_gain), eq_params),
            analyser_buffer,
        ));
        about
    } else if let Ok(source) = build_symphonia_decoder(bytes) {
        let about = (
            source.total_duration().map(|d| d.as_secs_f64()),
            "symphonia",
            source.sample_rate().get(),
            source.channels().get(),
        );
        player.append(AnalyserSource::new(
            EqSource::new(GainSource::new(source, normalization_gain), eq_params),
            analyser_buffer,
        ));
        about
    } else {
        // Not OGG-Opus by header sniff and symphonia refused it — last resort is the
        // custom Opus path (some streams carry Opus without a clean OpusHead page).
        let source =
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?;
        let about = (
            source.total_duration().map(|d| d.as_secs_f64()),
            "opus(fallback)",
            source.sample_rate().get(),
            source.channels().get(),
        );
        player.append(AnalyserSource::new(
            EqSource::new(GainSource::new(source, normalization_gain), eq_params),
            analyser_buffer,
        ));
        about
    };

    Ok(PreparedPlayer {
        player,
        duration_secs,
        decoder,
        sample_rate,
        channels,
    })
}

/// Короткая приметная строчка о байтах трека для лога: сколько их и что стоит в начале.
///
/// Первые байты решают всё: `ftyp` — mp4/m4a, `ID3`/`0xFF 0xFB` — mp3, `OggS` — ogg,
/// `#EXTM3U` — это вообще не аудио, а плейлист. Когда трек «не играет», ответ на вопрос
/// «а что вообще приехало» стоит одну строчку в логе и снимает половину догадок.
pub fn describe_bytes(bytes: &[u8]) -> String {
    let head = &bytes[..bytes.len().min(12)];
    let hex = head
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let kind = if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        "mp4/m4a"
    } else if bytes.starts_with(b"ID3") || bytes.starts_with(&[0xFF, 0xFB]) {
        "mp3"
    } else if is_ogg_opus(bytes) {
        "ogg/opus"
    } else if bytes.starts_with(b"OggS") {
        "ogg"
    } else if bytes.starts_with(b"#EXTM3U") {
        "HLS-плейлист"
    } else if bytes.starts_with(b"fLaC") {
        "flac"
    } else if bytes.starts_with(b"RIFF") {
        "wav"
    } else {
        "неизвестно"
    };
    format!("{} байт, {kind}, начало: {hex}", bytes.len())
}

#[cfg(test)]
mod tests {
    use super::create_player_from_bytes;
    use rodio::{Decoder, Source};
    use std::io::Cursor;

    /// Сколько секунд аудио реально достаёт декодер — со знанием длины файла и без него.
    ///
    /// Тест сравнивает два вызова на одном и том же файле: `Decoder::new`, как было до фикса,
    /// и `build_symphonia_decoder`, как стало. На mp4 с `moov` в конце (то, что раздаёт Яндекс
    /// Музыка) первый отвечает «формат не распознан», второй играет трек целиком. Держим его
    /// живым, чтобы регресс этого места был виден цифрами, а не жалобой «трек не играет».
    ///
    /// Файл с `moov` в конце получается из любого m4a обычным ремуксом без `+faststart`:
    /// `ffmpeg -i in.m4a -c:a copy out.m4a`.
    ///
    /// ```text
    /// LOMIFY_TEST_AUDIO_FILE=.claude/tmp/ya_moov_end.m4a \
    ///   cargo test --lib audio::decode::tests::decoded_length_with_and_without_byte_len -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "нужен путь к файлу в LOMIFY_TEST_AUDIO_FILE"]
    fn decoded_length_with_and_without_byte_len() {
        let path = std::env::var("LOMIFY_TEST_AUDIO_FILE")
            .expect("нет LOMIFY_TEST_AUDIO_FILE — путь к файлу с аудио");
        let bytes = std::fs::read(&path).expect("файл не читается");
        println!("{}: {} байт", path, bytes.len());

        let describe = |label: &str, source: Result<Decoder<Cursor<Vec<u8>>>, _>| match source {
            Ok(source) => {
                let rate = source.sample_rate().get() as f64;
                let channels = source.channels().get() as f64;
                let reported = source.total_duration();
                let samples = source.count() as f64;
                let decoded = samples / (rate * channels);
                println!(
                    "{label}: {rate} Гц, {channels} кан., total_duration={reported:?}, \
                     реально декодировано {decoded:.1} с"
                );
                Some(decoded)
            }
            Err(e) => {
                println!("{label}: декодер отказался — {e}");
                None
            }
        };

        describe("как было", Decoder::new(Cursor::new(bytes.clone())));
        let decoded = describe("как сейчас", super::build_symphonia_decoder(&bytes))
            .expect("декодер приложения не взял файл");

        // 30 секунд — заведомо больше «короткого звука в начале» и заведомо меньше любого
        // трека, которым имеет смысл проверять.
        assert!(
            decoded > 30.0,
            "декодировано всего {decoded:.1} с — файл обрывается на первых кадрах"
        );
    }

    /// Проигрывает файл на настоящем устройстве вывода и следит, идёт ли время.
    ///
    /// Отделяет «декодер отдал не всё аудио» от «поток встал на выходе»: снаружи это одно и
    /// то же — короткий звук в начале и тишина. Тест собирает ровно ту цепочку, что и плеер
    /// (нормализация → эквалайзер → анализатор → `Player` на миксере устройства), и печатает
    /// позицию каждые пол-секунды. Заодно видно, прилетела ли от cpal ошибка потока: именно
    /// она в приложении рвёт звук после первых миллисекунд.
    ///
    /// Тест звучит в колонках — громкость намеренно низкая.
    ///
    /// ```text
    /// LOMIFY_TEST_AUDIO_FILE=.claude/tmp/throwback_aac.m4a \
    ///   cargo test --lib audio::decode::tests::device_keeps_pulling -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "live audio: открывает настоящее устройство вывода и играет несколько секунд"]
    fn device_keeps_pulling() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let path = std::env::var("LOMIFY_TEST_AUDIO_FILE")
            .expect("нет LOMIFY_TEST_AUDIO_FILE — путь к файлу с аудио");
        let bytes = std::fs::read(&path).expect("файл не читается");

        let (tx, rx) = std::sync::mpsc::channel();
        let error_flag = Arc::new(AtomicBool::new(false));
        let sink = crate::audio::device::open_device_sink(None, &tx, &error_flag)
            .expect("устройство вывода не открылось");

        let prepared = create_player_from_bytes(
            &bytes,
            sink.mixer(),
            0.08,
            1.0,
            false,
            Default::default(),
            crate::audio::analyser::AnalyserBuffer::new(),
        )
        .expect("плеер не собрался");
        println!(
            "{} байт, декодер {}, {} Гц, {} кан., длительность от декодера: {:?}",
            bytes.len(),
            prepared.decoder,
            prepared.sample_rate,
            prepared.channels,
            prepared.duration_secs
        );
        let player = prepared.player;

        for step in 1..=10 {
            std::thread::sleep(Duration::from_millis(500));
            println!(
                "{:>4} мс стены: pos={:?}, empty={}, device_error={}",
                step * 500,
                player.get_pos(),
                player.empty(),
                error_flag.load(Ordering::Relaxed)
            );
        }
        while let Ok(cmd) = rx.try_recv() {
            let kind = match cmd {
                crate::audio::types::AudioThreadCmd::Reconnect => "переоткрыть устройство",
                crate::audio::types::AudioThreadCmd::SwitchDevice { .. } => "сменить устройство",
            };
            println!("аудиопоток попросил: {kind}");
        }

        let pos = player.get_pos().as_secs_f64();
        assert!(
            !player.empty() && pos > 3.0,
            "за 5 секунд стены проигралось {pos:.2} с (empty={}) — поток встал",
            player.empty()
        );
    }
}

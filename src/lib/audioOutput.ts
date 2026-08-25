/**
 * Выбор устройства воспроизведения.
 *
 * Вся работа с железом лежит в src-tauri/src/audio/device.rs: там перечисление устройств,
 * открытие сходу нового sink'а и перенос играющего трека на него без разрыва. Здесь —
 * только обёртка над тремя командами и одно правило, которое иначе пришлось бы повторять
 * в каждом месте вызова: слежение за системным устройством и ручной выбор устройства
 * взаимоисключающие.
 */

import { get } from 'svelte/store';
import { settings, notify } from './stores';

/** Ответ `audio_list_devices` — `AudioSink` из src-tauri/src/audio/types.rs. */
export interface AudioOutput {
  /** Идентификатор для переключения: cpal device id на Windows/macOS, имя sink'а на Linux. */
  name: string;
  /** Имя для человека — то, что показывает система. */
  description: string;
  /** Это устройство сейчас выбрано системой по умолчанию. */
  is_default: boolean;
}

/** В браузере (vite dev без Tauri) команд нет — обёртки должны молча ничего не делать. */
function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function listOutputs(): Promise<AudioOutput[]> {
  if (!hasTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<AudioOutput[]>('audio_list_devices');
}

/**
 * Открывает вывод на устройстве `name`; `null` — системное по умолчанию.
 *
 * Порядок вызовов важен. Слежение снимается ДО переключения: монитор в device.rs
 * сравнивает системный дефолт с последним известным и, увидев расхождение, сам уводит
 * вывод на дефолт — то есть отменил бы только что сделанный выбор. И наоборот, при
 * возврате на «системное» слежение включается заранее, чтобы `switch_device` записал
 * актуальный дефолт как уже применённый и монитор не считал его новой сменой.
 *
 * Бросает, если устройство не открылось (отключили наушники). Звук при этом не пропадает:
 * выходной поток в этом случае откатывается на устройство по умолчанию.
 */
export async function applyOutput(name: string | null): Promise<void> {
  if (!hasTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('audio_set_follow_default_output', { follow: name === null });
  await invoke('audio_switch_device', { deviceName: name });
}

/**
 * Возвращает вывод на сохранённое устройство при запуске приложения.
 *
 * Аудио-поток в Rust поднимается на системном устройстве по умолчанию и о настройках
 * ничего не знает — они лежат в localStorage. Поэтому выбор нужно применить заново на
 * каждом старте, иначе он работал бы только до перезапуска.
 *
 * Настройку не сбрасываем, если устройство не нашлось: колонку могли выключить на вечер,
 * а выбор человек делал не на один сеанс. Настройки покажут такое устройство отдельной
 * строкой «не найдено», пока оно не вернётся.
 */
export async function restoreSavedOutput(): Promise<void> {
  const saved = get(settings).outputDevice;
  if (!saved) return;

  try {
    await applyOutput(saved);
  } catch (e) {
    const label = get(settings).outputDeviceLabel || saved;
    notify(`Устройство «${label}» не найдено — играю через системное`, 'info');
    console.error('[audio] restore output device failed', e);
  }
}

//! Local visual QA for the exact browser response, without opening an account session.
#[path = "../src/auth_browser.rs"]
mod auth_browser;
use std::{io::Read, net::TcpListener};
use auth_browser::{AuthProvider, AuthResult};

fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 43830))?;
    println!("Auth page preview: http://127.0.0.1:43830/google");
    for stream in listener.incoming() {
        let mut stream = stream?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(3)))?;
        let mut bytes = [0u8; 2048];
        let size = stream.read(&mut bytes)?;
        let request = String::from_utf8_lossy(&bytes[..size]);
        let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
        let provider = if target.starts_with("/spotify") { AuthProvider::Spotify } else { AuthProvider::Google };
        let result = if target.starts_with("/cancelled") { AuthResult::Cancelled } else if target.starts_with("/invalid") { AuthResult::Invalid } else { AuthResult::Received };
        auth_browser::write_response(&mut stream, provider, result)?;
    }
    Ok(())
}

// OpenClaw Desktop v2 — Tauri backend
// Handles WebSocket connection to the OpenClaw Gateway

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

type WsSink = Arc<Mutex<Option<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>>>>;

struct AppState {
    ws_sink: WsSink,
    msg_id: Arc<Mutex<u64>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Attachment {
    name: String,
    content: String, // base64
    #[serde(rename = "mimeType")]
    mime_type: String,
}

#[derive(Debug, Serialize, Clone)]
struct WsStatus {
    connected: bool,
    message: String,
}

// Connect to gateway WebSocket
#[tauri::command]
async fn ws_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    token: String,
) -> Result<String, String> {
    // Disconnect existing connection
    {
        let mut sink = state.ws_sink.lock().await;
        if let Some(ref mut s) = *sink {
            let _ = s.close().await;
        }
        *sink = None;
    }

    let (ws_stream, _) = connect_async(&url)
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    let (write, mut read) = ws_stream.split();
    {
        let mut sink = state.ws_sink.lock().await;
        *sink = Some(write);
    }

    // Send connect/auth message
    let connect_msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "connect",
        "params": {
            "auth": { "token": token },
            "sender": { "id": "openclaw-desktop-v2", "name": "OpenClaw Desktop" }
        }
    });
    {
        let mut sink = state.ws_sink.lock().await;
        if let Some(ref mut s) = *sink {
            s.send(Message::Text(connect_msg.to_string().into()))
                .await
                .map_err(|e| format!("Auth send failed: {e}"))?;
        }
    }

    let _ = app.emit("ws-status", WsStatus {
        connected: true,
        message: "Connected".into(),
    });

    // Spawn read loop
    let app_handle = app.clone();
    let ws_sink_clone = state.ws_sink.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let _ = app_handle.emit("ws-message", text.to_string());
                }
                Ok(Message::Ping(data)) => {
                    let mut sink = ws_sink_clone.lock().await;
                    if let Some(ref mut s) = *sink {
                        let _ = s.send(Message::Pong(data.into())).await;
                    }
                }
                Ok(Message::Close(_)) => {
                    let _ = app_handle.emit("ws-status", WsStatus {
                        connected: false,
                        message: "Server closed connection".into(),
                    });
                    break;
                }
                Err(e) => {
                    let _ = app_handle.emit("ws-status", WsStatus {
                        connected: false,
                        message: format!("Connection error: {e}"),
                    });
                    break;
                }
                _ => {}
            }
        }
        let mut sink = ws_sink_clone.lock().await;
        *sink = None;
    });

    Ok("Connected".into())
}

// Send raw JSON-RPC message
#[tauri::command]
async fn ws_send(
    state: tauri::State<'_, AppState>,
    method: String,
    params: serde_json::Value,
) -> Result<u64, String> {
    let mut id_lock = state.msg_id.lock().await;
    *id_lock += 1;
    let id = *id_lock;

    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });

    let mut sink = state.ws_sink.lock().await;
    if let Some(ref mut s) = *sink {
        s.send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("Send failed: {e}"))?;
        Ok(id)
    } else {
        Err("Not connected".into())
    }
}

// Disconnect
#[tauri::command]
async fn ws_disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut sink = state.ws_sink.lock().await;
    if let Some(ref mut s) = *sink {
        let _ = s.close().await;
    }
    *sink = None;
    Ok(())
}

// Read file and return base64
#[tauri::command]
async fn read_file_base64(path: String) -> Result<(String, String), String> {
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
    let mime = mime_from_ext(&path);
    Ok((encoded, mime))
}

fn mime_from_ext(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "js" => "text/javascript",
        "ts" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "html" => "text/html",
        "css" => "text/css",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .into()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            ws_sink: Arc::new(Mutex::new(None)),
            msg_id: Arc::new(Mutex::new(1)),
        })
        .invoke_handler(tauri::generate_handler![
            ws_connect,
            ws_send,
            ws_disconnect,
            read_file_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// OpenClaw Desktop v2 — Tauri backend
// Handles WebSocket connection to the OpenClaw Gateway

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::{Message, client::IntoClientRequest}};
use sha2::{Sha256, Digest};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

type WsSink = Arc<Mutex<Option<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>>>>;

struct AppState {
    ws_sink: WsSink,
    msg_id: Arc<Mutex<u64>>,
}

#[derive(Debug, Serialize, Clone)]
struct WsStatus {
    connected: bool,
    message: String,
}

// Connect to gateway WebSocket (raw — no auto-auth, frontend handles its own protocol)
#[tauri::command]
async fn ws_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    // Disconnect existing connection
    {
        let mut sink = state.ws_sink.lock().await;
        if let Some(ref mut s) = *sink {
            let _ = s.close().await;
        }
        *sink = None;
    }

    println!("[ws] Connecting to: {}", url);
    let mut request = url.into_client_request()
        .map_err(|e| format!("Invalid URL: {e}"))?;
    request.headers_mut().insert(
        "Origin",
        "http://tauri.localhost".parse().unwrap(),
    );
    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| {
            println!("[ws] Connection FAILED: {}", e);
            format!("Connection failed: {e}")
        })?;
    println!("[ws] Connected successfully!");

    let (write, mut read) = ws_stream.split();
    {
        let mut sink = state.ws_sink.lock().await;
        *sink = Some(write);
    }

    let _ = app.emit("ws-status", WsStatus {
        connected: true,
        message: "WebSocket open".into(),
    });

    // Spawn read loop — forwards all messages to frontend via events
    let app_handle = app.clone();
    let ws_sink_clone = state.ws_sink.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let text_str = text.to_string();
                    println!("[ws] << {}", if text_str.len() > 200 { &text_str[..200] } else { &text_str });
                    let _ = app_handle.emit("ws-message", text_str);
                }
                Ok(Message::Ping(data)) => {
                    let mut sink = ws_sink_clone.lock().await;
                    if let Some(ref mut s) = *sink {
                        let _ = s.send(Message::Pong(data.into())).await;
                    }
                }
                Ok(Message::Close(frame)) => {
                    println!("[ws] Server closed: {:?}", frame);
                    let _ = app_handle.emit("ws-status", WsStatus {
                        connected: false,
                        message: "Server closed connection".into(),
                    });
                    break;
                }
                Err(e) => {
                    println!("[ws] Connection error: {}", e);
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

// Send raw text message (frontend handles its own protocol framing)
#[tauri::command]
async fn ws_send_raw(
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    println!("[ws] >> {}", if message.len() > 200 { &message[..200] } else { &message });
    let mut sink = state.ws_sink.lock().await;
    if let Some(ref mut s) = *sink {
        s.send(Message::Text(message.into()))
            .await
            .map_err(|e| {
                println!("[ws] Send FAILED: {}", e);
                format!("Send failed: {e}")
            })?;
        Ok(())
    } else {
        println!("[ws] Send failed: not connected");
        Err("Not connected".into())
    }
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

#[derive(Serialize)]
struct DeviceSignaturePayload {
    #[serde(rename = "id")]
    device_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    signature: String,
    #[serde(rename = "signedAt")]
    signed_at: u64,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignDeviceRequest {
    client_id: String,
    client_mode: String,
    role: String,
    scopes: Vec<String>,
    token: String,
    nonce: String,
    platform: String,
    device_family: String,
}

#[tauri::command]
async fn sign_device_v3(req: SignDeviceRequest) -> Result<DeviceSignaturePayload, String> {
    let key_path = std::env::temp_dir().join("openclaw_identity.hex");
    
    let signing_key = std::fs::read_to_string(&key_path)
        .ok()
        .and_then(|h| hex::decode(h.trim()).ok())
        .and_then(|b| if b.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&b);
            Some(SigningKey::from_bytes(&arr))
        } else {
            None
        })
        .unwrap_or_else(|| {
            let mut csprng = OsRng;
            let k = SigningKey::generate(&mut csprng);
            let _ = std::fs::write(&key_path, hex::encode(k.to_bytes()));
            k
        });

    let public_key = signing_key.verifying_key();
    let pk_bytes = public_key.as_bytes();
    
    let mut hasher = Sha256::new();
    hasher.update(pk_bytes);
    let device_id = hex::encode(hasher.finalize());
    
    let signed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
        
    let joined_scopes = req.scopes.join(",");
    let payload_str = format!("v3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        device_id,
        req.client_id,
        req.client_mode,
        req.role,
        joined_scopes,
        signed_at,
        req.token,
        req.nonce,
        req.platform,
        req.device_family
    );
    
    let signature = signing_key.sign(payload_str.as_bytes());

    Ok(DeviceSignaturePayload {
        device_id,
        public_key: URL_SAFE_NO_PAD.encode(pk_bytes),
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        signed_at,
        nonce: req.nonce,
    })
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
            ws_send_raw,
            ws_disconnect,
            read_file_base64,
            sign_device_v3,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

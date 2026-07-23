//! ello-app 原生桥:sidecar 进程生命周期、newline-delimited frame 转发、
//! secure storage。桥不解析 JSON-RPC method,不修改 payload,
//! 不实现 Thread/Workspace 业务规则 —— 协议事实只属于 @ello/agent。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum SidecarEvent {
    Frame { data: String },
    Stderr { data: String },
    Exit { data: ExitPayload },
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

struct SidecarHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct SidecarState(Mutex<Option<SidecarHandle>>);

/// sidecar 解析:
/// 1. 打包资源 binaries/ 下首个 ello-agent* 可执行文件(externalBin 按 target triple 命名)。
fn resolve_sidecar(app: &AppHandle) -> Result<Command, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resource dir unavailable: {error}"))?;
    let binaries = resource.join("binaries");
    let entries = std::fs::read_dir(&binaries)
        .map_err(|error| format!("binaries dir unreadable: {error}"))?;
    let binary = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("ello-agent"))
        })
        .ok_or_else(|| {
            format!(
                "bundled ello-agent sidecar is missing under {}",
                binaries.display()
            )
        })?;
    let mut command = Command::new(binary);
    command.arg("--listen").arg("stdio://");
    Ok(command)
}

#[tauri::command]
async fn sidecar_start(
    app: AppHandle,
    state: State<'_, SidecarState>,
    on_event: Channel<SidecarEvent>,
) -> Result<(), String> {
    {
        let guard = state.0.lock().map_err(|_| "sidecar state poisoned")?;
        if guard.is_some() {
            return Err("sidecar is already running".to_string());
        }
    }

    let mut command = resolve_sidecar(&app)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn ello-agent sidecar: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar stdin was not piped".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout was not piped".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "sidecar stderr was not piped".to_string())?;

    // stdout:完整行即一条 JSON-RPC frame,原样转发。
    let frame_channel = on_event.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(data) if !data.trim().is_empty() => {
                    if frame_channel.send(SidecarEvent::Frame { data }).is_err() {
                        return;
                    }
                }
                Ok(_) => continue,
                Err(_) => return,
            }
        }
    });

    // stderr:诊断输出,不属于协议流。
    let stderr_channel = on_event.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = stderr_channel.send(SidecarEvent::Stderr { data: line });
        }
    });

    {
        let mut guard = state.0.lock().map_err(|_| "sidecar state poisoned")?;
        *guard = Some(SidecarHandle { child, stdin });
    }

    // 退出事件:进程结束时通知 WebView 进入 fatal connection state。
    std::thread::spawn(move || {
        let code = loop {
            let exited = {
                let state = app.state::<SidecarState>();
                let mut guard = match state.0.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                match guard.as_mut() {
                    Some(handle) => match handle.child.try_wait() {
                        Ok(Some(status)) => Some(status.code()),
                        Ok(None) => None,
                        Err(_) => Some(None),
                    },
                    None => return,
                }
            };
            match exited {
                Some(code) => break code,
                None => std::thread::sleep(std::time::Duration::from_millis(120)),
            }
        };
        {
            let state = app.state::<SidecarState>();
            let mut guard = match state.0.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            *guard = None;
        }
        let _ = on_event.send(SidecarEvent::Exit {
            data: ExitPayload { code },
        });
    });

    Ok(())
}

#[tauri::command]
async fn sidecar_send(state: State<'_, SidecarState>, frame: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "sidecar state poisoned")?;
    let handle = guard
        .as_mut()
        .ok_or_else(|| "sidecar is not running".to_string())?;
    handle
        .stdin
        .write_all(frame.as_bytes())
        .and_then(|()| handle.stdin.write_all(b"\n"))
        .and_then(|()| handle.stdin.flush())
        .map_err(|error| format!("failed to write to sidecar stdin: {error}"))
}

#[tauri::command]
async fn sidecar_kill(state: State<'_, SidecarState>, reason: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "sidecar state poisoned")?;
    if let Some(mut handle) = guard.take() {
        let _ = reason;
        handle
            .child
            .kill()
            .map_err(|error| format!("failed to kill sidecar: {error}"))?;
        let _ = handle.child.wait();
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_start,
            sidecar_send,
            sidecar_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ello");
}

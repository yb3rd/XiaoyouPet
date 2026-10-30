use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewWindow, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct PetState {
    zones: Mutex<Vec<Zone>>,
    click_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[derive(Clone, Deserialize, Default, PartialEq)]
struct Zone {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Serialize)]
struct FileEntry {
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct HistoryItem {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
}

#[derive(Serialize)]
struct ModelEntry {
    #[serde(rename = "providerID")]
    provider_id: String,
    id: String,
    name: String,
}

#[derive(Serialize, Clone)]
struct NewsItem {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<String>,
}

#[derive(Serialize)]
struct SongTrack {
    name: String,
    path: String,
    title: String,
    artist: String,
    source: String,
}

fn sanitize_filename(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.chars().count() >= 80 {
            break;
        }
        if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            continue;
        }
        out.push(ch);
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "song".to_string()
    } else {
        trimmed
    }
}

fn project_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut cur = exe.parent()?.to_path_buf();
    for _ in 0..6 {
        if cur.join("tauri.conf.json").exists() && cur.join("Cargo.toml").exists() {
            return cur.parent().map(|path| path.to_path_buf());
        }
        cur = cur.parent()?.to_path_buf();
    }
    None
}

fn asset_root(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("PET_ASSET_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join("models").is_dir() || dir.join("animations").is_dir() {
                return dir.to_path_buf();
            }
        }
    }
    if let Some(root) = project_root() {
        return root;
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn models_dir(app: &AppHandle) -> PathBuf {
    asset_root(app).join("models")
}

fn animations_dir(app: &AppHandle) -> PathBuf {
    asset_root(app).join("animations")
}

fn music_dir(app: &AppHandle) -> PathBuf {
    asset_root(app).join("mp3")
}

fn music_cache_dir(app: &AppHandle) -> PathBuf {
    asset_root(app).join("music_cache")
}

fn memory_dir(app: &AppHandle) -> PathBuf {
    asset_root(app).join("memory")
}

fn memory_file(app: &AppHandle) -> PathBuf {
    memory_dir(app).join("memory.json")
}

fn list_files(dir: &Path, ext: &str) -> Vec<FileEntry> {
    let mut list = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return list;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let matches = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(ext))
            .unwrap_or(false);
        if !matches {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        list.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
        });
    }
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

#[tauri::command]
fn list_model_files(app: AppHandle) -> Vec<FileEntry> {
    let dir = models_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    list_files(&dir, "vrm")
}

#[tauri::command]
fn list_animations(app: AppHandle) -> Vec<FileEntry> {
    let dir = animations_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    list_files(&dir, "vrma")
}

#[tauri::command]
fn list_music(app: AppHandle) -> Vec<FileEntry> {
    let dir = music_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    list_files(&dir, "mp3")
        .into_iter()
        .filter(|entry| {
            std::fs::metadata(&entry.path)
                .map(|meta| meta.is_file() && meta.len() > 0)
                .unwrap_or(false)
        })
        .collect()
}

#[tauri::command]
async fn fetch_song(app: AppHandle, query: String) -> serde_json::Value {
    let query = query.trim().chars().take(80).collect::<String>();
    if query.is_empty() {
        return json!({ "ok": false, "error": "empty query" });
    }
    let client = match reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    let search_response = client
        .get("https://music.163.com/api/search/get/web")
        .query(&[("s", query.as_str()), ("type", "1"), ("limit", "8")])
        .header("Referer", "https://music.163.com/")
        .send()
        .await;
    let search_json = match search_response {
        Ok(response) => match response.json::<serde_json::Value>().await {
            Ok(json) => json,
            Err(error) => return json!({ "ok": false, "error": error.to_string() }),
        },
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    let songs = search_json
        .get("result")
        .and_then(|result| result.get("songs"))
        .and_then(|songs| songs.as_array())
        .cloned()
        .unwrap_or_default();
    if songs.is_empty() {
        return json!({ "ok": false, "error": "not found" });
    }

    let dir = music_cache_dir(&app);
    if std::fs::create_dir_all(&dir).is_err() {
        return json!({ "ok": false, "error": "cannot create music_cache" });
    }
    let mut last_error = String::from("not found");
    for song in songs.iter().take(3) {
        let Some(id) = song.get("id").and_then(|value| value.as_u64()) else {
            continue;
        };
        let title = song
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let artist = song
            .get("artists")
            .and_then(|value| value.as_array())
            .map(|artists| {
                artists
                    .iter()
                    .filter_map(|artist| artist.get("name").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join(" / ")
            })
            .unwrap_or_default();
        let display = if artist.is_empty() {
            title.clone()
        } else {
            format!("{title} - {artist}")
        };
        let file = dir.join(format!(
            "netease-{id}-{}.mp3",
            sanitize_filename(&display)
        ));
        if let Ok(meta) = std::fs::metadata(&file) {
            if meta.len() > 32_768 {
                return json!({
                    "ok": true,
                    "track": SongTrack {
                        name: display,
                        path: file.to_string_lossy().to_string(),
                        title,
                        artist,
                        source: "网易云音乐".to_string(),
                    }
                });
            }
        }

        let url = format!("https://music.163.com/song/media/outer/url?id={id}.mp3");
        let response = match client
            .get(&url)
            .header("Referer", "https://music.163.com/")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = format!("status {}", response.status());
            continue;
        }
        if let Some(content_type) = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
        {
            if content_type.starts_with("text/") {
                last_error = "invalid content type".to_string();
                continue;
            }
        }
        if response.content_length().unwrap_or(0) > 60_000_000 {
            last_error = "file too large".to_string();
            continue;
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if bytes.len() < 32_768 {
            last_error = "file too small".to_string();
            continue;
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let tmp = dir.join(format!(".download-{id}-{stamp}.part"));
        if std::fs::write(&tmp, bytes.as_ref()).is_err() {
            last_error = "write failed".to_string();
            continue;
        }
        let _ = std::fs::remove_file(&file);
        if std::fs::rename(&tmp, &file).is_err() {
            let _ = std::fs::remove_file(&tmp);
            last_error = "rename failed".to_string();
            continue;
        }
        return json!({
            "ok": true,
            "track": SongTrack {
                name: display,
                path: file.to_string_lossy().to_string(),
                title,
                artist,
                source: "网易云音乐".to_string(),
            }
        });
    }
    json!({ "ok": false, "error": last_error })
}

#[tauri::command]
fn load_memory(app: AppHandle) -> serde_json::Value {
    let file = memory_file(&app);
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn save_memory(app: AppHandle, data: serde_json::Value) -> bool {
    let file = memory_file(&app);
    let Some(dir) = file.parent() else {
        return false;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let Ok(text) = serde_json::to_string_pretty(&data) else {
        return false;
    };
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_err() {
        return false;
    }
    let _ = std::fs::remove_file(&file);
    std::fs::rename(&tmp, &file).is_ok()
}

#[tauri::command]
async fn pick_animation(app: AppHandle) -> Option<FileEntry> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择 VRMA 动作文件")
        .add_filter("VRM Animation", &["vrma"])
        .blocking_pick_file();
    let picked = picked?;
    let source = picked.as_path()?.to_path_buf();
    let file_name = source.file_name()?.to_os_string();
    let dir = animations_dir(&app);
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(file_name);
    std::fs::copy(&source, &dest).ok()?;
    let name = dest
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    Some(FileEntry {
        name,
        path: dest.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn open_models(app: AppHandle) -> bool {
    let dir = models_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .arg(&dir)
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&dir).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    }
    true
}

#[tauri::command]
fn open_url(url: String) -> bool {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
    true
}

fn read_service() -> Option<(String, String)> {
    let home = dirs::home_dir()?;
    let file = home.join(".local").join("state").join("opencode").join("service.json");
    let text = std::fs::read_to_string(file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let url = json.get("url")?.as_str()?.to_string();
    let password = json.get("password")?.as_str()?.to_string();
    Some((url, password))
}

#[tauri::command]
async fn chat(
    text: String,
    history: Option<Vec<HistoryItem>>,
    model: Option<serde_json::Value>,
    memory: Option<String>,
    system: Option<String>,
) -> ChatResult {
    let text = text.trim().to_string();
    if text.is_empty() {
        return ChatResult {
            ok: false,
            text: None,
            error: Some("empty".into()),
            status: None,
        };
    }
    let history = history.unwrap_or_default();
    let start = history.len().saturating_sub(24);
    let lines = history[start..]
        .iter()
        .map(|item| {
            let who = if item.role == "user" { "用户" } else { "助手" };
            format!("{who}：{}", item.content)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let system_prompt = system.unwrap_or_else(|| {
        "你是桌面宠物助手，用简洁、自然、口语化的中文回答。尽量一句话说完，不超过50个字，适合朗读。"
            .to_string()
    });
    let prompt = [
        system_prompt,
        memory.unwrap_or_default(),
        if lines.is_empty() {
            String::new()
        } else {
            format!("最近的对话：\n{lines}")
        },
        format!("用户：{text}"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");

    let Some((url, password)) = read_service() else {
        return ChatResult {
            ok: false,
            text: None,
            error: Some("OpenCode service not found".into()),
            status: None,
        };
    };

    let mut body = json!({ "prompt": prompt });
    if let Some(value) = model {
        let valid = value.get("providerID").is_some() && value.get("id").is_some();
        if valid {
            body["model"] = value;
        }
    }

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{url}/api/experimental/generate/text"))
        .basic_auth("opencode", Some(password))
        .json(&body)
        .send()
        .await;

    match response {
        Ok(res) if res.status().is_success() => {
            let status = res.status().as_u16();
            match res.json::<serde_json::Value>().await {
                Ok(json) => {
                    let reply = json
                        .get("data")
                        .and_then(|data| data.get("text"))
                        .and_then(|value| value.as_str())
                        .or_else(|| json.get("text").and_then(|value| value.as_str()))
                        .unwrap_or_default()
                        .to_string();
                    ChatResult {
                        ok: true,
                        text: Some(reply),
                        error: None,
                        status: Some(status),
                    }
                }
                Err(error) => ChatResult {
                    ok: false,
                    text: None,
                    error: Some(error.to_string()),
                    status: Some(status),
                },
            }
        }
        Ok(res) => ChatResult {
            ok: false,
            text: None,
            error: None,
            status: Some(res.status().as_u16()),
        },
        Err(error) => ChatResult {
            ok: false,
            text: None,
            error: Some(error.to_string()),
            status: None,
        },
    }
}

#[tauri::command]
async fn list_models() -> Vec<ModelEntry> {
    let Some((url, password)) = read_service() else {
        return Vec::new();
    };
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{url}/api/model"))
        .basic_auth("opencode", Some(password))
        .send()
        .await;
    let Ok(response) = response else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(json) = response.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    let Some(items) = json.get("data").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let provider_id = item.get("providerID")?.as_str()?.to_string();
            let id = item
                .get("modelID")
                .and_then(|value| value.as_str())
                .or_else(|| item.get("id").and_then(|value| value.as_str()))?
                .to_string();
            let name = item
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(&id)
                .to_string();
            Some(ModelEntry {
                provider_id,
                id,
                name,
            })
        })
        .collect()
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(url).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    response.text().await.map_err(|error| error.to_string())
}

async fn bilibili_rank(rid: u32) -> Result<Vec<NewsItem>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let json = client
        .get(format!(
            "https://api.bilibili.com/x/web-interface/ranking/v2?rid={rid}&type=all"
        ))
        .header("referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    let mut items = json
        .get("data")
        .and_then(|data| data.get("list"))
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let title = item.get("title")?.as_str()?.trim().to_string();
                    if title.is_empty() {
                        return None;
                    }
                    let owner = item
                        .get("owner")
                        .and_then(|owner| owner.get("name"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("B站");
                    let url = item
                        .get("bvid")
                        .and_then(|value| value.as_str())
                        .map(|bvid| format!("https://www.bilibili.com/video/{bvid}"));
                    Some(NewsItem {
                        title,
                        url,
                        source: "B站".to_string(),
                        meta: Some(owner.to_string()),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    items.truncate(6);
    if items.is_empty() {
        return Err("empty".into());
    }
    Ok(items)
}

fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn extract_tag(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = block.find(&open)? + open.len();
    let after = &block[start..];
    let end = after.find(&close)?;
    let raw = after[..end].trim();
    let raw = raw.strip_prefix("<![CDATA[").unwrap_or(raw);
    let raw = raw.strip_suffix("]]>").unwrap_or(raw).trim();
    Some(decode_entities(raw))
}

fn strip_html(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for ch in text.chars() {
        match ch {
            '<' => inside = true,
            '>' => {
                inside = false;
                out.push(' ');
            }
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out.split_whitespace().collect::<Vec<_>>().join(" "))
}

async fn rss_news(url: &str, limit: usize) -> Result<Vec<NewsItem>, String> {
    let xml = fetch_text(url).await?;
    let mut items = Vec::new();
    let mut rest = xml.as_str();
    while let Some(start) = rest.find("<item>") {
        let Some(end) = rest[start..].find("</item>") else {
            break;
        };
        let block = &rest[start..start + end + 7];
        if let Some(title) = extract_tag(block, "title") {
            if !title.trim().is_empty() {
                let link = extract_tag(block, "link")
                    .filter(|value| value.starts_with("http://") || value.starts_with("https://"));
                let meta = extract_tag(block, "description").map(|text| {
                    let text = strip_html(&text);
                    if text.chars().count() > 140 {
                        format!("{}…", text.chars().take(140).collect::<String>())
                    } else {
                        text
                    }
                });
                items.push(NewsItem {
                    title,
                    url: link,
                    source: "机核".to_string(),
                    meta,
                });
            }
        }
        rest = &rest[start + end + 7..];
        if items.len() >= limit {
            break;
        }
    }
    if items.is_empty() {
        Err("empty".into())
    } else {
        Ok(items)
    }
}

async fn hacker_news(query: &str, tags: &str, limit: u32) -> Result<Vec<NewsItem>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let limit_text = limit.to_string();
    let mut request = client
        .get("https://hn.algolia.com/api/v1/search")
        .query(&[("tags", tags), ("hitsPerPage", limit_text.as_str())]);
    if !query.is_empty() {
        request = request.query(&[("query", query)]);
    }
    let json = request
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    let items = json
        .get("hits")
        .and_then(|value| value.as_array())
        .map(|hits| {
            hits.iter()
                .filter_map(|hit| {
                    let title = hit.get("title")?.as_str()?.trim().to_string();
                    if title.is_empty() || title.contains("HN is for") {
                        return None;
                    }
                    let object_id = hit
                        .get("objectID")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    let url = hit
                        .get("url")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string())
                        .or_else(|| {
                            if object_id.is_empty() {
                                None
                            } else {
                                Some(format!("https://news.ycombinator.com/item?id={object_id}"))
                            }
                        });
                    let points = hit
                        .get("points")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(0);
                    let comments = hit
                        .get("num_comments")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(0);
                    Some(NewsItem {
                        title,
                        url,
                        source: "Hacker News".to_string(),
                        meta: Some(format!("{points} points · {comments} comments")),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(items)
}

fn news_response(mut details: Vec<NewsItem>, limit: usize) -> serde_json::Value {
    details.truncate(limit);
    let items = details
        .iter()
        .map(|item| item.title.clone())
        .collect::<Vec<_>>();
    json!({ "ok": true, "items": items, "details": details })
}

#[tauri::command]
async fn topic(kind: String) -> serde_json::Value {
    match kind.as_str() {
        "weather" => match fetch_text("https://wttr.in/?format=3").await {
            Ok(text) => json!({ "ok": true, "text": text.trim() }),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "ai-news" => match hacker_news("AI", "story", 12).await {
            Ok(details) => news_response(details, 3),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "world-news" => match hacker_news("", "front_page", 8).await {
            Ok(details) => news_response(details, 4),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "anime-news" => match bilibili_rank(1).await {
            Ok(details) => news_response(details, 4),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "game-news" => match bilibili_rank(4).await {
            Ok(details) => news_response(details, 4),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "acg-news" => match rss_news("https://www.gcores.com/rss", 4).await {
            Ok(details) => news_response(details, 4),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        _ => json!({ "ok": false }),
    }
}

#[tauri::command]
fn has_piper_voice(app: AppHandle) -> bool {
    let root = asset_root(&app).join("voices").join("piper");
    root.join("piper").join("piper.exe").is_file()
        && root.join("zh_CN-huayan-medium.onnx").is_file()
}

fn rate_to_length_scale(rate: &str) -> f64 {
    let value = rate
        .trim()
        .trim_end_matches('%')
        .parse::<f64>()
        .unwrap_or(0.0);
    (1.0 / (1.0 + value / 100.0)).clamp(0.5, 2.0)
}

async fn speak_piper(app: &AppHandle, text: &str, rate: &str) -> serde_json::Value {
    let root = asset_root(app).join("voices").join("piper");
    let exe = root.join("piper").join("piper.exe");
    let model = root.join("zh_CN-huayan-medium.onnx");
    if !exe.is_file() || !model.is_file() {
        return json!({ "ok": false, "error": "piper voice not installed" });
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let file = std::env::temp_dir().join(format!("xiaoyou-piper-{millis}.wav"));
    let mut command = tokio::process::Command::new(&exe);
    command
        .arg("--model")
        .arg(&model)
        .arg("--output_file")
        .arg(&file)
        .arg("--length_scale")
        .arg(format!("{:.3}", rate_to_length_scale(rate)))
        .arg("--espeak_data")
        .arg(root.join("piper").join("espeak-ng-data"))
        .current_dir(root.join("piper"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        if let Err(error) = stdin.write_all(text.as_bytes()).await {
            let _ = child.kill().await;
            return json!({ "ok": false, "error": error.to_string() });
        }
        let _ = stdin.shutdown().await;
    }
    let output = match child.wait_with_output().await {
        Ok(output) => output,
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    let result = if output.status.success() {
        match std::fs::read(&file) {
            Ok(bytes) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                json!({ "ok": true, "audio": format!("data:audio/wav;base64,{encoded}") })
            }
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        }
    } else {
        json!({
            "ok": false,
            "error": String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    };
    let _ = std::fs::remove_file(&file);
    result
}

#[tauri::command]
async fn speak(
    app: AppHandle,
    text: String,
    voice: String,
    rate: String,
    pitch: String,
) -> serde_json::Value {
    let text = text.chars().take(500).collect::<String>();
    if text.trim().is_empty() || voice == "system" {
        return json!({ "ok": false });
    }
    if voice == "piper-huayan" {
        return speak_piper(&app, &text, &rate).await;
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let file = std::env::temp_dir().join(format!("xiaoyou-pet-{millis}.mp3"));

    let mut command = tokio::process::Command::new("python");
    command.args([
        "-m",
        "edge_tts",
        "--voice",
        &voice,
        "--rate",
        &rate,
        "--pitch",
        &pitch,
        "--text",
        &text,
        "--write-media",
    ]);
    command.arg(&file);
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let output = command.output().await;
    let result = match output {
        Ok(output) if output.status.success() => match std::fs::read(&file) {
            Ok(bytes) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                json!({ "ok": true, "audio": format!("data:audio/mpeg;base64,{encoded}") })
            }
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        },
        Ok(output) => json!({
            "ok": false,
            "error": String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    };
    let _ = std::fs::remove_file(&file);
    result
}

#[tauri::command]
fn set_window_scale(window: WebviewWindow, scale: f64) -> serde_json::Value {
    let requested = scale.clamp(0.8, 4.9);
    let Ok(Some(monitor)) = window.current_monitor() else {
        return json!({ "ok": false });
    };
    let dpi = monitor.scale_factor();
    let size = monitor.size();
    let logical_width = size.width as f64 / dpi;
    let logical_height = size.height as f64 / dpi;
    let window_scale = if requested <= 1.0 {
        1.0
    } else {
        let max_width = ((logical_width - 40.0) / 300.0).max(1.0);
        let max_height = ((logical_height - 76.0) / 340.0).max(1.0);
        requested.min(max_width).min(max_height)
    };
    let width = 300.0 * window_scale;
    let height = 340.0 * window_scale;
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let x = (logical_width - width - 20.0).max(0.0);
    let y = (logical_height - height - 56.0).max(0.0);
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    json!({
        "ok": true,
        "requested": requested,
        "actual": if requested < 1.0 { requested } else { window_scale },
        "windowScale": window_scale,
    })
}

#[tauri::command]
fn set_click_through(app: AppHandle, window: WebviewWindow, enabled: bool) {
    let _ = window.set_ignore_cursor_events(enabled);
    if let Ok(item) = app.state::<PetState>().click_item.lock() {
        if let Some(item) = item.as_ref() {
            let _ = item.set_checked(enabled);
        }
    }
}

fn toggle_click_through(app: &AppHandle) {
    let state = app.state::<PetState>();
    let enabled = {
        let item = state.click_item.lock().ok();
        item.and_then(|item| item.as_ref().and_then(|item| item.is_checked().ok()))
            .map(|checked| !checked)
            .unwrap_or(true)
    };
    if let Ok(item) = state.click_item.lock() {
        if let Some(item) = item.as_ref() {
            let _ = item.set_checked(enabled);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_ignore_cursor_events(enabled);
    }
    let _ = app.emit("click-through-changed", enabled);
}

#[tauri::command]
fn set_zones(window: WebviewWindow, state: State<'_, PetState>, zones: Vec<Zone>) {
    #[cfg(windows)]
    ensure_frameless(&window);
    let zones = zones
        .into_iter()
        .filter(|zone| zone.w > 1.0 && zone.h > 1.0)
        .collect::<Vec<_>>();
    if let Ok(mut stored) = state.zones.lock() {
        if !stored.is_empty() && *stored == zones {
            return;
        }
        *stored = zones.clone();
    }
    #[cfg(windows)]
    {
        let _ = apply_window_region(&window, &zones);
    }
    #[cfg(not(windows))]
    {
        let _ = &window;
    }
}

#[cfg(windows)]
fn ensure_frameless(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_STYLE, WS_CAPTION};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let style = GetWindowLongW(hwnd.0 as _, GWL_STYLE);
        if style & (WS_CAPTION as i32) == 0 {
            return;
        }
    }
    remove_window_frame(window);
}

#[cfg(windows)]
fn remove_window_frame(window: &WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    use windows_sys::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU,
        WS_THICKFRAME,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let style = GetWindowLongW(hwnd.0 as _, GWL_STYLE);
        let frame_mask =
            (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU) as i32;
        let new_style = style & !frame_mask;
        SetWindowLongW(hwnd.0 as _, GWL_STYLE, new_style);
        SetWindowPos(
            hwnd.0 as _,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );

        // DWM can keep drawing a cached non-client title bar even after WS_CAPTION
        // is removed, especially while the window is inactive. Disable NC rendering.
        let value: u32 = 1; // DWMNCRP_DISABLED
        DwmSetWindowAttribute(hwnd.0 as _, 2, &value as *const u32 as *const _, 4);
        RedrawWindow(
            hwnd.0 as _,
            std::ptr::null(),
            std::ptr::null_mut(),
            RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_UPDATENOW | RDW_ALLCHILDREN,
        );
    }
}

#[cfg(windows)]
fn apply_window_region(window: &WebviewWindow, zones: &[Zone]) -> tauri::Result<()> {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
    };

    let scale = window.scale_factor()?;
    let hwnd = window.hwnd()?;

    unsafe {
        let region = CreateRectRgn(0, 0, 0, 0);
        if region.is_null() {
            return Ok(());
        }
        let mut has_area = false;
        for zone in zones {
            let left = (zone.x * scale).round() as i32;
            let top = (zone.y * scale).round() as i32;
            let right = ((zone.x + zone.w) * scale).round() as i32;
            let bottom = ((zone.y + zone.h) * scale).round() as i32;
            if right - left < 2 || bottom - top < 2 {
                continue;
            }
            let piece = CreateRectRgn(left, top, right, bottom);
            if piece.is_null() {
                continue;
            }
            CombineRgn(region, region, piece, RGN_OR);
            DeleteObject(piece);
            has_area = true;
        }
        if !has_area {
            let piece = CreateRectRgn(0, 0, 2, 2);
            if !piece.is_null() {
                CombineRgn(region, region, piece, RGN_OR);
                DeleteObject(piece);
            }
        }
        let applied = SetWindowRgn(hwnd.0 as _, region, 1);
        if applied == 0 {
            DeleteObject(region);
        }
    }
    Ok(())
}

fn place_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let width = (300.0 * scale).round() as i32;
    let height = (340.0 * scale).round() as i32;
    let margin = (20.0 * scale).round() as i32;
    let bottom = (56.0 * scale).round() as i32;
    let x = size.width as i32 - width - margin;
    let y = size.height as i32 - height - bottom;
    let _ = window.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(windows)]
                ensure_frameless(&window);
                let _ = window.show();
                let _ = window.set_focus();
                #[cfg(windows)]
                {
                    let _ = apply_window_region(
                        &window,
                        &[Zone {
                            x: 40.0,
                            y: 28.0,
                            w: 220.0,
                            h: 312.0,
                        }],
                    );
                }
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_click_through(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(PetState {
            zones: Mutex::new(Vec::new()),
            click_item: Mutex::new(None),
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_decorations(false);
                let _ = window.set_resizable(false);
                #[cfg(windows)]
                remove_window_frame(&window);
                #[cfg(windows)]
                {
                    let _ = apply_window_region(
                        &window,
                        &[Zone {
                            x: 40.0,
                            y: 28.0,
                            w: 220.0,
                            h: 312.0,
                        }],
                    );
                }
                place_bottom_right(&window);

                let win_events = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(_) = event {
                        #[cfg(windows)]
                        remove_window_frame(&win_events);
                    }
                });

                #[cfg(windows)]
                {
                    let win = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(1200));
                        let win2 = win.clone();
                        let _ = win.run_on_main_thread(move || {
                            remove_window_frame(&win2);
                            let _ = win2.show();
                            let _ = win2.set_focus();
                            let _ = apply_window_region(
                                &win2,
                                &[Zone {
                                    x: 40.0,
                                    y: 28.0,
                                    w: 220.0,
                                    h: 312.0,
                                }],
                            );
                        });
                    });
                }
                #[cfg(not(windows))]
                {
                    let _ = window.show();
                }
            }
            let handle = app.handle().clone();
            let _ = std::fs::create_dir_all(models_dir(&handle));
            let _ = std::fs::create_dir_all(animations_dir(&handle));
            let _ = std::fs::create_dir_all(music_dir(&handle));
            let _ = std::fs::create_dir_all(memory_dir(&handle));

            let click_item = CheckMenuItem::with_id(
                app,
                "click_through",
                "点击穿透（不挡其他窗口）",
                true,
                false,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&click_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("小尤桌宠 v2026.10.29")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "click_through" => toggle_click_through(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            if let Ok(mut item) = app.state::<PetState>().click_item.lock() {
                *item = Some(click_item);
            }
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                eprintln!("failed to register global shortcut: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat,
            list_models,
            list_model_files,
            list_animations,
            list_music,
            fetch_song,
            load_memory,
            save_memory,
            open_url,
            pick_animation,
            open_models,
            topic,
            speak,
            has_piper_voice,
            set_window_scale,
            set_zones,
            set_click_through
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

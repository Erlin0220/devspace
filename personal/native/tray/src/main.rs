#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
// Tray protocol, single-instance ownership and rendering snapshot: Team DevSpace 15ce088.
// Personal branding is generated locally; no external image/runtime dependency.
#[cfg(not(target_os = "windows"))]
compile_error!("Use the native Swift frontend on macOS");
use serde::Deserialize;
use std::{collections::HashMap, io::{self, BufRead, Write}, thread};
use tray_icon::{menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu}, Icon, TrayIcon, TrayIconBuilder};
use winit::{application::ApplicationHandler, event_loop::{ActiveEventLoop, EventLoop}};

struct InstanceGuard { handle: windows_sys::Win32::Foundation::HANDLE }
impl InstanceGuard {
    fn acquire(id: &str) -> io::Result<Option<Self>> {
        use windows_sys::Win32::{Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError}, System::Threading::CreateMutexW};
        let name = format!("Local\\PersonalDevSpace.Tray.{id}\0").encode_utf16().collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() { return Err(io::Error::last_os_error()); }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS { unsafe { CloseHandle(handle) }; return Ok(None); }
        Ok(Some(Self { handle }))
    }
}
impl Drop for InstanceGuard { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) }; } }
#[derive(Clone, Debug, Deserialize)]
struct MenuEntry {
    id: String, text: String, enabled: bool,
    #[serde(default)] action: String,
    #[serde(default)] separator: bool,
    #[serde(default)] children: Vec<MenuEntry>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayState { status: String, icon_status: String, tooltip: String, menu: Vec<MenuEntry> }
impl TrayState {
    fn entries(&self) -> impl Iterator<Item = &MenuEntry> { self.menu.iter().flat_map(|item| std::iter::once(item).chain(item.children.iter())) }
    fn valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        ["ready", "partial", "suspended", "busy", "stopped"].contains(&self.status.as_str())
            && ["ready", "partial", "suspended", "busy", "stopped"].contains(&self.icon_status.as_str())
            && !self.menu.is_empty() && self.menu.len() <= 20 && self.entries().count() <= 32
            && self.menu.iter().all(|item| item.children.is_empty() || (!item.separator && item.action.is_empty() && item.children.iter().all(|child| child.children.is_empty())))
            && self.entries().all(|item| !item.id.is_empty() && item.id.len() <= 64 && ids.insert(&item.id))
    }
}
#[derive(Debug)]
enum UserEvent { State(TrayState), Menu(MenuId), Exercise(String), InputClosed }
struct Application {
    tray: Option<TrayIcon>, items: HashMap<String, MenuItem>, submenus: HashMap<String, Submenu>, layout: Vec<String>,
    state: Option<TrayState>, last_icon: String, smoke: bool,
}
fn emit(event: &str, mut fields: serde_json::Value) {
    fields["event"] = event.into(); let mut stdout = io::stdout().lock(); let _ = writeln!(stdout, "{fields}"); let _ = stdout.flush();
}
fn bounded_text(value: &str, max: usize) -> String {
    if value.chars().count() <= max { value.to_owned() } else { format!("{}…", value.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn icon(status: &str) -> Icon {
    let fill = match status { "ready" => [41, 163, 92], "partial" => [230, 166, 35], "suspended" => [211, 64, 83], "busy" => [55, 125, 220], _ => [123, 132, 145] };
    let mut rgba = vec![0_u8; 32 * 32 * 4];
    for y in 3_i32..29 { for x in 3_i32..29 {
        let border = x < 7 || y < 7 || y > 24 || x > 24;
        let rgb = if border { [75, 151, 255] } else { [15, 23, 34] };
        let offset = ((y * 32 + x) * 4) as usize; rgba[offset..offset+3].copy_from_slice(&rgb); rgba[offset+3] = 255;
    } }
    for y in 18_i32..32 { for x in 18_i32..32 {
        let d = (x-25)*(x-25)+(y-25)*(y-25);
        if d <= 42 { let offset = ((y*32+x)*4) as usize; rgba[offset..offset+3].copy_from_slice(&fill); rgba[offset+3] = 255; }
    } }
    Icon::from_rgba(rgba, 32, 32).expect("valid tray icon")
}
impl Application {
    fn update(&mut self, state: TrayState) {
        let layout = state.entries().map(|item| format!("{}:{}:{}", item.id, item.separator, item.children.len())).collect::<Vec<_>>();
        if layout != self.layout {
            let menu = Menu::new(); let mut items = HashMap::new(); let mut submenus = HashMap::new(); let mut failed = false;
            for entry in &state.menu {
                if entry.separator { failed |= menu.append(&PredefinedMenuItem::separator()).is_err(); }
                else if !entry.children.is_empty() {
                    let submenu = Submenu::new(bounded_text(&entry.text, 64), entry.enabled);
                    for child in &entry.children {
                        if child.separator { failed |= submenu.append(&PredefinedMenuItem::separator()).is_err(); }
                        else { let item = MenuItem::new(bounded_text(&child.text, 64), child.enabled, None);
                            if submenu.append(&item).is_err() { failed = true; } else { items.insert(child.id.clone(), item); } }
                    }
                    if menu.append(&submenu).is_err() { failed = true; } else { submenus.insert(entry.id.clone(), submenu); }
                } else { let item = MenuItem::new(bounded_text(&entry.text, 64), entry.enabled, None);
                    if menu.append(&item).is_err() { failed = true; } else { items.insert(entry.id.clone(), item); } }
            }
            if !failed { if let Some(tray) = &self.tray { tray.set_menu(Some(Box::new(menu))); self.items = items; self.submenus = submenus; self.layout = layout; } }
            else { eprintln!("Tray menu update failed; retaining previous menu"); }
        }
        for entry in state.entries() {
            if let Some(item) = self.items.get(&entry.id) { item.set_text(bounded_text(&entry.text, 64)); item.set_enabled(entry.enabled); }
            if let Some(item) = self.submenus.get(&entry.id) { item.set_text(bounded_text(&entry.text, 64)); item.set_enabled(entry.enabled); }
        }
        if let Some(tray) = &self.tray {
            let _ = tray.set_tooltip(Some(bounded_text(&state.tooltip, 110)));
            if self.last_icon != state.icon_status { let _ = tray.set_icon(Some(icon(&state.icon_status))); self.last_icon = state.icon_status.clone(); }
        }
        if self.smoke { emit("state-applied", serde_json::json!({"status": state.status})); } self.state = Some(state);
    }
    fn activate(&self, id: &MenuId) {
        if let Some(state) = &self.state {
            if let Some(entry) = state.menu.iter().filter(|entry| entry.enabled).flat_map(|entry| std::iter::once(entry).chain(entry.children.iter()))
                .find(|entry| entry.enabled && !entry.action.is_empty() && self.items.get(&entry.id).is_some_and(|item| item.id() == id)) {
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(u32::MAX) };
                emit("menu", serde_json::json!({"action": entry.action}));
            }
        }
    }
}
impl ApplicationHandler<UserEvent> for Application {
    fn resumed(&mut self, _: &ActiveEventLoop) {}
    fn window_event(&mut self, _: &ActiveEventLoop, _: winit::window::WindowId, _: winit::event::WindowEvent) {}
    fn new_events(&mut self, _: &ActiveEventLoop, cause: winit::event::StartCause) {
        if cause == winit::event::StartCause::Init {
            self.tray = Some(TrayIconBuilder::new().with_tooltip("Personal DevSpace · 正在启动…").with_icon(icon("stopped")).build().expect("create tray icon"));
            emit("ready", serde_json::json!({})); emit("tray-visible", serde_json::json!({}));
        }
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event { UserEvent::State(state) => self.update(state), UserEvent::InputClosed => event_loop.exit(),
            UserEvent::Menu(id) => self.activate(&id), UserEvent::Exercise(key) => { if let Some(item) = self.items.get(&key) { self.activate(item.id()); } } }
    }
}
fn valid_instance_id(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn main() {
    let identity = match std::env::var("PERSONAL_DEVSPACE_TRAY_INSTANCE_ID") {
        Ok(value) if valid_instance_id(&value) => value, _ => { eprintln!("Start through the Personal controller"); std::process::exit(1); }
    };
    let _guard = match InstanceGuard::acquire(&identity) {
        Ok(Some(guard)) => guard, Ok(None) => { emit("duplicate", serde_json::json!({})); return; }, Err(error) => { eprintln!("Tray owner: {error}"); std::process::exit(1); }
    };
    let smoke = std::env::args().any(|arg| arg == "--smoke");
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().expect("create event loop");
    let proxy = event_loop.create_proxy(); MenuEvent::set_event_handler(Some(move |event: MenuEvent| { let _ = proxy.send_event(UserEvent::Menu(event.id)); }));
    let proxy = event_loop.create_proxy();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let event = line.ok().filter(|line| line.len() <= 65536).and_then(|line| serde_json::from_str::<serde_json::Value>(&line).ok()).and_then(|value| {
                if smoke { if let Some(key) = value.get("exerciseMenu").and_then(|value| value.as_str()) { return Some(UserEvent::Exercise(key.to_owned())); } }
                serde_json::from_value::<TrayState>(value).ok().filter(TrayState::valid).map(UserEvent::State)
            });
            match event { Some(event) => { let _ = proxy.send_event(event); }, None => emit("protocol-error", serde_json::json!({})) }
        }
        let _ = proxy.send_event(UserEvent::InputClosed);
    });
    let mut app = Application { tray: None, items: HashMap::new(), submenus: HashMap::new(), layout: vec![], state: None, last_icon: String::new(), smoke };
    if event_loop.run_app(&mut app).is_err() { std::process::exit(1); }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn identities_and_icons_are_bounded() {
        assert!(valid_instance_id(&"a0".repeat(32))); assert!(!valid_instance_id("../unsafe"));
        assert!(bounded_text(&"长".repeat(200), 64).chars().count() <= 64);
        for status in ["ready", "partial", "suspended", "busy", "stopped"] { let _ = icon(status); }
    }
}

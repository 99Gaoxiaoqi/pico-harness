use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::ptr::null_mut;

type Sid = *mut c_void;

#[repr(C)]
struct SidAndAttributes {
    sid: Sid,
    attributes: u32,
}

#[link(name = "userenv")]
extern "system" {
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Sid) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn ConvertSidToStringSidW(sid: Sid, string_sid: *mut *mut u16) -> i32;
    fn EqualSid(first: Sid, second: Sid) -> i32;
    fn FreeSid(sid: Sid) -> Sid;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> u32;
    fn GetProcessHeap() -> *mut c_void;
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn HeapFree(heap: *mut c_void, flags: u32, memory: *mut c_void) -> i32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(path: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
}

pub fn validate_profile_name(name: &str) -> Result<(), String> {
    let suffix = name
        .strip_prefix("PicoTaskNetwork.")
        .ok_or("invalid task network profile prefix")?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("task network profile must end in 32 lowercase hexadecimal characters".into());
    }
    Ok(())
}

pub fn helper_mutex_name(name: &str) -> Result<String, String> {
    validate_profile_name(name)?;
    Ok(format!("Local\\PicoHarness.TaskNetwork.{name}"))
}

pub fn profile_sid_string(name: &str) -> Result<String, String> {
    validate_profile_name(name)?;
    let profile = wide_null(name);
    let mut sid: Sid = null_mut();
    let status = unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) };
    if status < 0 || sid.is_null() {
        return Err(format!(
            "DeriveAppContainerSidFromAppContainerName failed: HRESULT 0x{status:08x}"
        ));
    }
    let mut string_sid: *mut u16 = null_mut();
    let result = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };
    unsafe { FreeSid(sid) };
    if result == 0 || string_sid.is_null() {
        return Err(format!("ConvertSidToStringSidW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut length = 0;
    while length < 256 && unsafe { *string_sid.add(length) } != 0 {
        length += 1;
    }
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(string_sid, length) });
    unsafe { LocalFree(string_sid.cast()) };
    if length == 256 || !value.starts_with("S-1-15-2-") {
        return Err("derived task network AppContainer SID is invalid".into());
    }
    Ok(value)
}

pub fn loopback_exempt(name: &str) -> Result<bool, String> {
    validate_profile_name(name)?;
    let library_path = wide_null(system_directory()?.join("Firewallapi.dll"));
    let wide = wide_null(name);
    let mut target: Sid = null_mut();
    let status = unsafe { DeriveAppContainerSidFromAppContainerName(wide.as_ptr(), &mut target) };
    if status < 0 || target.is_null() {
        return Err(format!(
            "DeriveAppContainerSidFromAppContainerName failed: HRESULT 0x{status:08x}"
        ));
    }
    let library = unsafe { LoadLibraryW(library_path.as_ptr()) };
    if library.is_null() {
        unsafe { FreeSid(target) };
        return Err(format!(
            "LoadLibraryW(Firewallapi.dll) failed: {}",
            unsafe { GetLastError() }
        ));
    }
    let address =
        unsafe { GetProcAddress(library, b"NetworkIsolationGetAppContainerConfig\0".as_ptr()) };
    if address.is_null() {
        let error = unsafe { GetLastError() };
        unsafe { FreeLibrary(library) };
        unsafe { FreeSid(target) };
        return Err(format!(
            "GetProcAddress(NetworkIsolationGetAppContainerConfig) failed: {error}"
        ));
    }
    let get_config: unsafe extern "system" fn(*mut u32, *mut *mut SidAndAttributes) -> u32 =
        unsafe { std::mem::transmute(address) };
    let mut count = 0u32;
    let mut entries: *mut SidAndAttributes = null_mut();
    let query = unsafe { get_config(&mut count, &mut entries) };
    unsafe { FreeLibrary(library) };
    if query != 0 {
        unsafe { FreeSid(target) };
        return Err(format!(
            "NetworkIsolationGetAppContainerConfig failed: {query}"
        ));
    }
    let mut found = false;
    if !entries.is_null() {
        for index in 0..count as usize {
            let candidate = unsafe { &*entries.add(index) };
            if !candidate.sid.is_null() {
                if unsafe { EqualSid(target, candidate.sid) } != 0 {
                    found = true;
                }
                unsafe { HeapFree(GetProcessHeap(), 0, candidate.sid) };
            }
        }
        unsafe { HeapFree(GetProcessHeap(), 0, entries.cast()) };
    }
    unsafe { FreeSid(target) };
    Ok(found)
}

pub fn set_loopback_exempt(name: &str, enable: bool) -> Result<&'static str, String> {
    validate_profile_name(name)?;
    let before = loopback_exempt(name)?;
    if before == enable {
        return Ok("no-change");
    }
    let sid = profile_sid_string(name)?;
    let program = system_directory()?.join("CheckNetIsolation.exe");
    let status = Command::new(&program)
        .current_dir(system_directory()?)
        .arg("LoopbackExempt")
        .arg(if enable { "-a" } else { "-d" })
        .arg(format!("-p={sid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .map_err(|error| format!("launch CheckNetIsolation.exe failed: {error}"))?;
    if !status.success() {
        return Err(format!("CheckNetIsolation.exe failed with {status}"));
    }
    if loopback_exempt(name)? != enable {
        return Err("task network loopback exemption did not reach the requested state".into());
    }
    Ok(if enable { "applied" } else { "revoked" })
}

fn system_directory() -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err("GetSystemDirectoryW failed".into());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

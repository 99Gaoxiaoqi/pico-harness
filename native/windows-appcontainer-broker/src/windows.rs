use std::collections::HashSet;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};

type Handle = *mut c_void;
type Sid = *mut c_void;

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const INFINITE: u32 = 0xffff_ffff;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x0000_1000;
const ERROR_ACCESS_DENIED: u32 = 5;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const INVALID_FILE_ATTRIBUTES: u32 = 0xffff_ffff;
const WAIT_OBJECT_0: u32 = 0;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const STD_INPUT_HANDLE: u32 = (-10i32) as u32;
const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;
const STD_ERROR_HANDLE: u32 = (-12i32) as u32;

#[repr(C)]
struct SecurityCapabilities {
    app_container_sid: Sid,
    capabilities: *mut SidAndAttributes,
    capability_count: u32,
    reserved: u32,
}

#[repr(C)]
struct SidAndAttributes {
    sid: Sid,
    attributes: u32,
}

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    reserved2_size: u16,
    reserved2: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[repr(C)]
struct StartupInfoExW {
    startup_info: StartupInfoW,
    attribute_list: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous_value: *mut c_void,
        return_size: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *const c_void,
        thread_attributes: *const c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *const c_void,
        current_directory: *const u16,
        startup_info: *const StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
    fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        information_class: i32,
        information: *const c_void,
        information_length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn GetProcessTimes(
        process: Handle,
        creation_time: *mut FileTime,
        exit_time: *mut FileTime,
        kernel_time: *mut FileTime,
        user_time: *mut FileTime,
    ) -> i32;
    fn GetFileAttributesW(file_name: *const u16) -> u32;
    fn GetStdHandle(standard_handle: u32) -> Handle;
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(algorithm: Handle, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

#[link(name = "userenv")]
extern "system" {
    fn CreateAppContainerProfile(
        name: *const u16,
        display_name: *const u16,
        description: *const u16,
        capabilities: *const SidAndAttributes,
        capability_count: u32,
        app_container_sid: *mut Sid,
    ) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Sid) -> i32;
    fn DeleteAppContainerProfile(name: *const u16) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut Sid) -> i32;
    fn FreeSid(sid: Sid) -> *mut c_void;
}

#[derive(Debug)]
struct Policy {
    cwd: PathBuf,
    scratch: PathBuf,
    control_root: PathBuf,
    generation: u64,
    read_roots: Vec<PathBuf>,
    write_roots: Vec<PathBuf>,
    command: String,
    args: Vec<String>,
}

pub fn run() -> Result<(), String> {
    let policy = parse_args(std::env::args().skip(1).collect())?;
    fs::create_dir_all(&policy.scratch).map_err(error_text)?;
    fs::create_dir_all(&policy.control_root).map_err(error_text)?;
    recover_stale(&policy.control_root)?;

    let nonce = secure_random_bytes()?;
    let package_name = format!(
        "PicoSandbox.{}.{}.{}",
        stable_hash(policy.scratch.to_string_lossy().as_bytes()),
        policy.generation,
        hex_prefix(&nonce, 8)
    );
    let target_capability_sid = target_capability_sid(&nonce);
    let process_started_at = current_process_started_at()?;
    let log_path = policy.control_root.join(format!(
        "broker-{}-{}-{}.log",
        std::process::id(),
        process_started_at,
        hex_prefix(&nonce, 16)
    ));

    // AppContainer ACLs are capability-scoped and recorded before mutation. A crash leaves
    // enough information for the next broker invocation to remove every temporary ACE.
    let mut journal = RecoveryJournal::open(&log_path)?;
    journal.record("profile", &package_name, "")?;
    let package_sid = match create_or_derive_package_sid(&package_name) {
        Ok(sid) => sid,
        Err(error) => {
            let _ = journal.cleanup();
            return Err(error);
        }
    };
    let launch_result = (|| -> Result<u32, String> {
        let write_keys = policy
            .write_roots
            .iter()
            .map(|path| path.to_string_lossy().to_lowercase())
            .collect::<HashSet<_>>();
        for root in policy.read_roots.iter().filter(|path| {
            !write_keys.contains(&path.to_string_lossy().to_lowercase()) && !is_system_root(path)
        }) {
            journal.grant(root, &target_capability_sid, "RX")?;
        }
        for root in &policy.write_roots {
            journal.grant(root, &target_capability_sid, "M")?;
        }
        unsafe { launch_in_appcontainer(&policy, package_sid, &target_capability_sid) }
    })();
    let cleanup_result = journal.cleanup();
    unsafe { FreeSid(package_sid) };
    let exit_code = launch_result?;
    cleanup_result?;
    std::process::exit(exit_code as i32);
}

fn parse_args(args: Vec<String>) -> Result<Policy, String> {
    let separator = args
        .iter()
        .position(|value| value == "--")
        .ok_or("missing -- command separator")?;
    if separator + 1 >= args.len() {
        return Err("missing target command".into());
    }
    let mut profile = None;
    let mut cwd = None;
    let mut scratch = None;
    let mut control_root = None;
    let mut generation = 0;
    let mut read_roots = Vec::new();
    let mut write_roots = Vec::new();
    let mut index = 0;
    while index < separator {
        let key = &args[index];
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("missing value for {key}"))?;
        match key.as_str() {
            "--profile" => profile = Some(value.clone()),
            "--cwd" => cwd = Some(PathBuf::from(value)),
            "--scratch" => scratch = Some(PathBuf::from(value)),
            "--control-root" => control_root = Some(PathBuf::from(value)),
            "--generation" => generation = value.parse().map_err(|_| "invalid generation")?,
            "--read-root" => read_roots.push(PathBuf::from(value)),
            "--write-root" => write_roots.push(PathBuf::from(value)),
            _ => return Err(format!("unknown policy argument: {key}")),
        }
        index += 2;
    }
    let profile = profile.ok_or("missing --profile")?;
    if profile != "read-only" && profile != "workspace-write" {
        return Err("broker only accepts restricted profiles".into());
    }
    Ok(Policy {
        cwd: cwd.ok_or("missing --cwd")?,
        scratch: scratch.ok_or("missing --scratch")?,
        control_root: control_root.ok_or("missing --control-root")?,
        generation,
        read_roots,
        write_roots,
        command: args[separator + 1].clone(),
        args: args[separator + 2..].to_vec(),
    })
}

unsafe fn launch_in_appcontainer(
    policy: &Policy,
    package_sid: Sid,
    target_capability_sid: &str,
) -> Result<u32, String> {
    let mut attribute_bytes = 0usize;
    InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
    if attribute_bytes == 0 {
        return Err(last_error("InitializeProcThreadAttributeList(size)"));
    }
    let mut attribute_storage = vec![0u8; attribute_bytes];
    let attribute_list = attribute_storage.as_mut_ptr().cast();
    if InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) == 0 {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let mut allocated_capability_sids: Vec<Sid> = Vec::new();
    let mut capability_entries = Vec::new();
    // Windows restricted profiles intentionally receive no network capabilities. The only
    // capability SID is process-specific and exists solely to scope temporary filesystem ACLs.
    for capability in std::iter::once(target_capability_sid) {
        let mut sid = null_mut();
        let wide = wide_null(capability);
        if ConvertStringSidToSidW(wide.as_ptr(), &mut sid) == 0 {
            DeleteProcThreadAttributeList(attribute_list);
            return Err(last_error("ConvertStringSidToSidW(capability)"));
        }
        allocated_capability_sids.push(sid);
        capability_entries.push(SidAndAttributes {
            sid,
            attributes: 0x4,
        });
    }
    let mut capabilities = SecurityCapabilities {
        app_container_sid: package_sid,
        capabilities: if capability_entries.is_empty() {
            null_mut()
        } else {
            capability_entries.as_mut_ptr()
        },
        capability_count: capability_entries.len() as u32,
        reserved: 0,
    };
    if UpdateProcThreadAttribute(
        attribute_list,
        0,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        (&mut capabilities as *mut SecurityCapabilities).cast(),
        size_of::<SecurityCapabilities>(),
        null_mut(),
        null_mut(),
    ) == 0
    {
        DeleteProcThreadAttributeList(attribute_list);
        return Err(last_error("UpdateProcThreadAttribute"));
    }

    let mut startup: StartupInfoExW = zeroed();
    startup.startup_info.cb = size_of::<StartupInfoExW>() as u32;
    startup.startup_info.flags = STARTF_USESTDHANDLES;
    startup.startup_info.std_input = GetStdHandle(STD_INPUT_HANDLE);
    startup.startup_info.std_output = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.startup_info.std_error = GetStdHandle(STD_ERROR_HANDLE);
    startup.attribute_list = attribute_list;
    let mut process: ProcessInformation = zeroed();
    let mut command_line = wide_null(&quote_command_line(&policy.command, &policy.args));
    let cwd = wide_null(policy.cwd.as_os_str());
    let created = CreateProcessW(
        null(),
        command_line.as_mut_ptr(),
        null(),
        null(),
        1,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
        null(),
        cwd.as_ptr(),
        &startup.startup_info,
        &mut process,
    );
    DeleteProcThreadAttributeList(attribute_list);
    for sid in allocated_capability_sids {
        LocalFree(sid);
    }
    if created == 0 {
        return Err(last_error("CreateProcessW(AppContainer)"));
    }

    let job = CreateJobObjectW(null(), null());
    if job.is_null() {
        let error = last_error("CreateJobObjectW");
        TerminateProcess(process.process, 1);
        WaitForSingleObject(process.process, INFINITE);
        close_process(process);
        return Err(error);
    }
    let mut limits: JobObjectExtendedLimitInformation = zeroed();
    limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        (&limits as *const JobObjectExtendedLimitInformation).cast(),
        size_of::<JobObjectExtendedLimitInformation>() as u32,
    ) == 0
        || AssignProcessToJobObject(job, process.process) == 0
    {
        let error = last_error("configure kill-on-close Job Object");
        TerminateProcess(process.process, 1);
        WaitForSingleObject(process.process, INFINITE);
        CloseHandle(job);
        close_process(process);
        return Err(error);
    }
    if ResumeThread(process.thread) == u32::MAX {
        let error = last_error("ResumeThread");
        CloseHandle(job);
        close_process(process);
        return Err(error);
    }
    if WaitForSingleObject(process.process, INFINITE) != WAIT_OBJECT_0 {
        let error = last_error("WaitForSingleObject(target)");
        TerminateProcess(process.process, 1);
        WaitForSingleObject(process.process, INFINITE);
        CloseHandle(job);
        close_process(process);
        return Err(error);
    }
    let mut exit_code = 1u32;
    if GetExitCodeProcess(process.process, &mut exit_code) == 0 {
        exit_code = 1;
    }
    CloseHandle(job);
    close_process(process);
    Ok(exit_code)
}

unsafe fn close_process(process: ProcessInformation) {
    if !process.thread.is_null() {
        CloseHandle(process.thread);
    }
    if !process.process.is_null() {
        CloseHandle(process.process);
    }
}

fn create_or_derive_package_sid(name: &str) -> Result<Sid, String> {
    let wide = wide_null(name);
    let display = wide_null("Pico process sandbox");
    let description = wide_null("Ephemeral Pico AppContainer process boundary");
    let mut sid = null_mut();
    let result = unsafe {
        CreateAppContainerProfile(
            wide.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if result >= 0 {
        return Ok(sid);
    }
    let derived = unsafe { DeriveAppContainerSidFromAppContainerName(wide.as_ptr(), &mut sid) };
    if derived < 0 || sid.is_null() {
        return Err(format!(
            "AppContainer profile creation failed: HRESULT 0x{result:08x}"
        ));
    }
    Ok(sid)
}

struct RecoveryJournal {
    path: PathBuf,
    entries: Vec<(String, String, String)>,
}

impl RecoveryJournal {
    fn open(path: &Path) -> Result<Self, String> {
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(error_text)?;
        Ok(Self {
            path: path.to_path_buf(),
            entries: Vec::new(),
        })
    }

    fn grant(&mut self, path: &Path, sid: &str, rights: &str) -> Result<(), String> {
        assert_not_reparse_point(path)?;
        let path_text = path.to_string_lossy().to_string();
        self.record("acl", &path_text, sid)?;
        let grant = format!("*{sid}:(OI)(CI){rights}");
        // Windows propagates inheritable ACEs to existing children. Avoid /T because a
        // string-based recursive traversal can cross a workspace junction into an external tree.
        run_icacls("grant", [&path_text, "/grant", &grant, "/C", "/L"])
    }

    fn record(&mut self, kind: &str, target: &str, sid: &str) -> Result<(), String> {
        self.entries.push((kind.into(), target.into(), sid.into()));
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(error_text)?;
        writeln!(file, "{kind}\t{}\t{sid}", escape_field(target)).map_err(error_text)?;
        file.sync_data().map_err(error_text)
    }

    fn cleanup(&mut self) -> Result<(), String> {
        cleanup_entries(&self.entries)?;
        self.entries.clear();
        fs::remove_file(&self.path)
            .or_else(ignore_not_found)
            .map_err(error_text)
    }
}

fn is_system_root(path: &Path) -> bool {
    let candidate = path.to_string_lossy().to_lowercase();
    ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(|root| root.to_string_lossy().to_lowercase())
        .any(|root| candidate == root || candidate.starts_with(&format!("{root}\\")))
}

fn recover_stale(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(error_text)? {
        let path = entry.map_err(error_text)?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }
        let owner = path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|name| name.strip_prefix("broker-"))
            .and_then(|name| {
                let mut parts = name.split('-');
                Some((
                    parts.next()?.parse::<u32>().ok()?,
                    parts.next()?.parse::<u64>().ok()?,
                ))
            });
        if owner.is_some_and(|(process_id, started_at)| process_is_running(process_id, started_at))
        {
            continue;
        }
        recover(&path)?;
    }
    Ok(())
}

fn process_is_running(process_id: u32, expected_started_at: u64) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if !handle.is_null() {
        let started_at = process_started_at(handle).ok();
        unsafe { CloseHandle(handle) };
        return started_at == Some(expected_started_at);
    }
    unsafe { GetLastError() == ERROR_ACCESS_DENIED }
}

fn current_process_started_at() -> Result<u64, String> {
    process_started_at(unsafe { GetCurrentProcess() })
}

fn process_started_at(process: Handle) -> Result<u64, String> {
    let mut creation: FileTime = unsafe { zeroed() };
    let mut exit: FileTime = unsafe { zeroed() };
    let mut kernel: FileTime = unsafe { zeroed() };
    let mut user: FileTime = unsafe { zeroed() };
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(last_error("GetProcessTimes"));
    }
    Ok((u64::from(creation.high_date_time) << 32) | u64::from(creation.low_date_time))
}

fn assert_not_reparse_point(path: &Path) -> Result<(), String> {
    let wide = wide_null(path.as_os_str());
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(format!(
            "policy root {}: {}",
            path.display(),
            last_error("GetFileAttributesW")
        ));
    }
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "policy root is a reparse point: {}",
            path.display()
        ));
    }
    Ok(())
}

fn recover(path: &Path) -> Result<(), String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error_text(error)),
    };
    let entries = contents
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            Some((
                fields.next()?.into(),
                unescape_field(fields.next()?),
                fields.next()?.into(),
            ))
        })
        .collect::<Vec<_>>();
    cleanup_entries(&entries)?;
    fs::remove_file(path)
        .or_else(ignore_not_found)
        .map_err(error_text)
}

fn cleanup_entries(entries: &[(String, String, String)]) -> Result<(), String> {
    for (kind, target, sid) in entries.iter().rev() {
        match kind.as_str() {
            "acl" => run_icacls(
                "cleanup",
                [target, "/remove", &format!("*{sid}"), "/C", "/L"],
            )?,
            "profile" => delete_appcontainer_profile(target)?,
            _ => return Err(format!("invalid recovery entry: {kind}")),
        }
    }
    Ok(())
}

fn delete_appcontainer_profile(name: &str) -> Result<(), String> {
    let wide = wide_null(name);
    let result = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
    let code = result as u32;
    if result >= 0 || code == 0x8007_0002 || code == 0x8007_0490 {
        Ok(())
    } else {
        Err(format!(
            "DeleteAppContainerProfile failed: HRESULT 0x{code:08x}"
        ))
    }
}

fn run_icacls<const N: usize>(operation: &str, args: [&str; N]) -> Result<(), String> {
    // The broker starts in the target workspace and inherits its environment. Resolve both the
    // executable and cwd from Kernel32 so neither a workspace file nor PATH/SystemRoot can select
    // the ACL control binary.
    let system_directory = system_directory()?;
    let program = system_directory.join("icacls.exe");
    let status = Command::new(&program)
        .current_dir(&system_directory)
        .args(args)
        // Broker 控制面不得污染目标 Hook 的 stdin/stdout JSON 协议。
        // stderr 保留继承，便于 ACL 失败时诊断。
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .map_err(error_text)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} {operation} failed with {status}",
            program.display()
        ))
    }
}

fn system_directory() -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(last_error("GetSystemDirectoryW"));
        }
        let length = length as usize;
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::system_directory;

    #[test]
    fn system_directory_is_absolute_and_contains_icacls() {
        let system_directory = system_directory().expect("system directory should resolve");
        assert!(system_directory.is_absolute());
        assert!(system_directory.join("icacls.exe").is_file());
    }
}

fn quote_command_line(command: &str, args: &[String]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(quote_windows_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return value.to_string();
    }
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
        } else if ch == '"' {
            output.push_str(&"\\".repeat(slashes * 2 + 1));
            output.push('"');
            slashes = 0;
        } else {
            output.push_str(&"\\".repeat(slashes));
            slashes = 0;
            output.push(ch);
        }
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn stable_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn secure_random_bytes() -> Result<[u8; 32], String> {
    let mut bytes = [0u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!(
            "BCryptGenRandom failed: NTSTATUS 0x{:08x}",
            status as u32
        ));
    }
    Ok(bytes)
}

fn hex_prefix(bytes: &[u8], length: usize) -> String {
    bytes
        .iter()
        .take(length)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn target_capability_sid(nonce: &[u8; 32]) -> String {
    let values = nonce
        .chunks_exact(4)
        .map(|part| u32::from_le_bytes([part[0], part[1], part[2], part[3]]))
        .collect::<Vec<_>>();
    format!(
        "S-1-15-3-1024-{}",
        values
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join("-")
    )
}

fn escape_field(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('\t', "%09")
        .replace('\n', "%0a")
}

fn unescape_field(value: &str) -> String {
    value
        .replace("%0a", "\n")
        .replace("%09", "\t")
        .replace("%25", "%")
}

fn ignore_not_found(error: io::Error) -> io::Result<()> {
    if error.kind() == io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

fn last_error(operation: &str) -> String {
    format!("{operation} failed with Win32 error {}", unsafe {
        GetLastError()
    })
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

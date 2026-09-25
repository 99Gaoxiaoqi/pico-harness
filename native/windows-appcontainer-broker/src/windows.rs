use std::collections::HashSet;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::Instant;

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
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const INVALID_FILE_ATTRIBUTES: u32 = 0xffff_ffff;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_ABANDONED: u32 = 0x0000_0080;
const WAIT_TIMEOUT: u32 = 0x0000_0102;
const WAIT_FAILED: u32 = 0xffff_ffff;
const ACL_MUTATION_TIMEOUT_MS: u32 = 15_000;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const STD_INPUT_HANDLE: u32 = (-10i32) as u32;
const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;
const STD_ERROR_HANDLE: u32 = (-12i32) as u32;
const TOKEN_QUERY: u32 = 0x0000_0008;

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
struct ByHandleFileInformation {
    file_attributes: u32,
    creation_time: FileTime,
    last_access_time: FileTime,
    last_write_time: FileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
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
    fn GetFileInformationByHandle(file: Handle, information: *mut ByHandleFileInformation) -> i32;
    fn GetStdHandle(standard_handle: u32) -> Handle;
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> Handle;
    fn ReleaseMutex(mutex: Handle) -> i32;
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
    fn GetUserProfileDirectoryW(token: Handle, profile_dir: *mut u16, size: *mut u32) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut Sid) -> i32;
    fn FreeSid(sid: Sid) -> *mut c_void;
    fn OpenProcessToken(process: Handle, desired_access: u32, token: *mut Handle) -> i32;
}

#[derive(Debug)]
struct Policy {
    cwd: PathBuf,
    metadata_root: Option<PathBuf>,
    scratch: PathBuf,
    control_root: PathBuf,
    generation: u64,
    read_roots: Vec<PathBuf>,
    write_roots: Vec<PathBuf>,
    read_files: Vec<PathBuf>,
    write_files: Vec<PathBuf>,
    command: String,
    args: Vec<String>,
}

struct AclMutationGuard {
    mutex: Handle,
}

impl AclMutationGuard {
    fn acquire() -> Result<Self, String> {
        // icacls updates a DACL through a read-modify-write operation. Different broker
        // processes can otherwise overwrite each other's capability ACE when they grant or
        // remove access on the same workspace. A session-local kernel mutex serializes only
        // those short mutations; sandboxed children still run concurrently.
        let name = wide_null("Local\\PicoHarness.AppContainerAcl.v1");
        let mutex = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if mutex.is_null() {
            return Err(last_error("CreateMutexW"));
        }
        match unsafe { WaitForSingleObject(mutex, ACL_MUTATION_TIMEOUT_MS) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self { mutex }),
            WAIT_TIMEOUT => {
                unsafe { CloseHandle(mutex) };
                Err(format!(
                    "timed out after {ACL_MUTATION_TIMEOUT_MS}ms waiting for the ACL mutation mutex"
                ))
            }
            WAIT_FAILED => {
                let error = last_error("WaitForSingleObject(ACL mutex)");
                unsafe { CloseHandle(mutex) };
                Err(error)
            }
            status => {
                unsafe { CloseHandle(mutex) };
                Err(format!("unexpected ACL mutex wait status: 0x{status:08x}"))
            }
        }
    }
}

impl Drop for AclMutationGuard {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.mutex);
            CloseHandle(self.mutex);
        }
    }
}

pub fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|argument| argument == "--commit-file")
    {
        return run_commit_file(&args[1..]);
    }
    let policy = parse_args(args)?;
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
    let mut exact_path_guards: Vec<File> = Vec::new();
    let launch_result = (|| -> Result<u32, String> {
        if !policy.read_files.is_empty() || !policy.write_files.is_empty() {
            grant_exact_cwd(
                &mut journal,
                &policy,
                &target_capability_sid,
                &mut exact_path_guards,
            )?;
        }
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
        for path in &policy.read_files {
            grant_exact_file(
                &mut journal,
                &policy,
                path,
                &target_capability_sid,
                "RX",
                true,
                &mut exact_path_guards,
            )?;
        }
        for path in &policy.write_files {
            grant_exact_file(
                &mut journal,
                &policy,
                path,
                &target_capability_sid,
                "M",
                true,
                &mut exact_path_guards,
            )?;
        }
        unsafe { launch_in_appcontainer(&policy, package_sid, &target_capability_sid) }
    })();
    let cleanup_result = journal.cleanup();
    drop(exact_path_guards);
    unsafe { FreeSid(package_sid) };
    let exit_code = match (launch_result, cleanup_result) {
        (Ok(code), Ok(())) => code,
        (Err(launch), Ok(())) => return Err(launch),
        (Ok(_), Err(cleanup)) => return Err(cleanup),
        (Err(launch), Err(cleanup)) => {
            return Err(format!(
                "target failed: {launch}; ACL cleanup also failed: {cleanup}"
            ));
        }
    };
    std::process::exit(exit_code as i32);
}

fn grant_exact_cwd(
    journal: &mut RecoveryJournal,
    policy: &Policy,
    sid: &str,
    guards: &mut Vec<File>,
) -> Result<(), String> {
    if !policy.cwd.is_absolute()
        || policy.cwd == policy.control_root
        || policy.cwd.starts_with(&policy.control_root)
    {
        return Err("exact-file working directory is invalid or overlaps broker control".into());
    }
    grant_exact_metadata_chain(journal, policy, &policy.cwd, sid, guards)
}

fn grant_exact_metadata_chain(
    journal: &mut RecoveryJournal,
    policy: &Policy,
    leaf: &Path,
    sid: &str,
    guards: &mut Vec<File>,
) -> Result<(), String> {
    let profile = current_user_profile_path()?;
    assert_not_reparse_point(&profile)?;
    let profile_guard = pin_path(&profile, true)?;
    assert_not_reparse_point(&profile)?;
    assert_pinned_identity(&profile, &profile_guard, true)?;
    let profile_identity = file_identity(&profile_guard)?;
    guards.push(profile_guard);
    let metadata_root_identity = match policy.metadata_root.as_deref() {
        Some(root) => {
            if !root.is_absolute()
                || root != policy.cwd
                || root.parent().is_none()
                || is_system_root(root)
            {
                return Err(
                    "file-worker metadata root must be its non-system working directory".into(),
                );
            }
            assert_not_reparse_point(root)?;
            let guard = pin_path(root, true)?;
            assert_not_reparse_point(root)?;
            assert_pinned_identity(root, &guard, true)?;
            let identity = file_identity(&guard)?;
            if is_profile_ancestor(identity, &profile)? {
                return Err("file-worker metadata root is a shared profile ancestor".into());
            }
            if identity != profile_identity
                && is_other_profile_subtree(root, &profile, profile_identity)?
            {
                return Err("file-worker metadata root is another user profile".into());
            }
            guards.push(guard);
            Some(identity)
        }
        None => None,
    };
    let mut ancestors = Vec::new();
    let mut current = Some(leaf);
    while let Some(directory) = current {
        if directory.parent().is_none() {
            break;
        }
        ancestors.push(directory);
        current = directory.parent();
    }
    let mut within_authorized_root = false;
    for directory in ancestors.into_iter().rev() {
        assert_not_reparse_point(directory).map_err(|error| {
            format!(
                "目标真实路径发生变化：目录 {} 无法检查：{error}",
                directory.display()
            )
        })?;
        let pinned = pin_path(directory, true).map_err(|error| {
            format!(
                "目标真实路径发生变化：目录 {} 无法固定：{error}",
                directory.display()
            )
        })?;
        assert_not_reparse_point(directory).map_err(|error| {
            format!(
                "目标真实路径发生变化：目录 {} 无法复核：{error}",
                directory.display()
            )
        })?;
        assert_pinned_identity(directory, &pinned, true)?;
        if !pinned.metadata().map_err(error_text)?.is_dir() {
            return Err(format!(
                "exact-file metadata ancestor is not a directory: {}",
                directory.display()
            ));
        }
        let identity = file_identity(&pinned)?;
        if identity == profile_identity || metadata_root_identity == Some(identity) {
            within_authorized_root = true;
        }
        guards.push(pinned);
        if !within_authorized_root {
            continue;
        }
        // Only the requested directory receives an ACE. Shared profile/Temp
        // ancestors stay unchanged; the Worker must use Host-bound canonical paths.
        if directory == leaf {
            journal.grant_exact_metadata(directory, identity, sid)?;
        }
    }
    if within_authorized_root {
        Ok(())
    } else {
        Err(format!(
            "exact-file metadata path is outside the current user profile and task root: {}",
            leaf.display()
        ))
    }
}

fn is_profile_ancestor(identity: (u32, u64), profile: &Path) -> Result<bool, String> {
    let mut current = profile.parent();
    while let Some(directory) = current {
        let pinned = pin_path(directory, true)?;
        if file_identity(&pinned)? == identity {
            return Ok(true);
        }
        current = directory.parent();
    }
    Ok(false)
}

fn is_other_profile_subtree(
    root: &Path,
    profile: &Path,
    profile_identity: (u32, u64),
) -> Result<bool, String> {
    let profile_parent = profile.parent().ok_or("user profile has no parent")?;
    let profile_parent_guard = pin_path(profile_parent, true)?;
    let profile_parent_identity = file_identity(&profile_parent_guard)?;
    let mut current = root;
    while let Some(parent) = current.parent() {
        let parent_guard = pin_path(parent, true)?;
        if file_identity(&parent_guard)? == profile_parent_identity {
            let child_guard = pin_path(current, true)?;
            return Ok(file_identity(&child_guard)? != profile_identity);
        }
        current = parent;
    }
    Ok(false)
}

fn run_commit_file(args: &[String]) -> Result<(), String> {
    if args.len() != 6 || args[0] != "--node" || args[2] != "--helper" || args[4] != "--target" {
        return Err("commit-file accepts only --node, --helper and --target".into());
    }
    let node = Path::new(&args[1]);
    let helper = Path::new(&args[3]);
    let target = Path::new(&args[5]);
    if !node.is_absolute()
        || !helper.is_absolute()
        || helper.file_name() != Some(OsStr::new("windows-file-commit-entry.js"))
        || !target.is_absolute()
    {
        return Err("commit-file requires absolute Node, helper and target paths".into());
    }
    let target_parent = target.parent().ok_or("commit-file target has no parent")?;
    assert_not_reparse_point(target_parent)?;
    let _parent_guard = pin_path(target_parent, true)?;
    assert_pinned_identity(target_parent, &_parent_guard, true)?;
    for path in [node, helper] {
        let mut current = Some(path);
        while let Some(component) = current {
            if component.parent().is_none() {
                break;
            }
            assert_not_reparse_point(component)?;
            current = component.parent();
        }
        if !fs::symlink_metadata(path).map_err(error_text)?.is_file() {
            return Err(format!(
                "commit-file trusted path is not a file: {}",
                path.display()
            ));
        }
    }
    let system_directory = system_directory()?;
    let system_root = system_directory
        .parent()
        .ok_or("Windows system directory has no parent")?;
    let mut request = Vec::new();
    std::io::stdin()
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut request)
        .map_err(error_text)?;
    if request.is_empty() || request.len() > 64 * 1024 * 1024 {
        return Err("commit-file request is empty or exceeds 64 MiB".into());
    }
    let mut child = Command::new(node)
        .arg(helper)
        .current_dir(&system_directory)
        .env_clear()
        .env("SystemRoot", system_root)
        .env("WINDIR", system_root)
        .env("ComSpec", system_directory.join("cmd.exe"))
        .env("PATH", &system_directory)
        .env("TEMP", std::env::temp_dir())
        .env("TMP", std::env::temp_dir())
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("PICO_COMMIT_BOUND_TARGET", target)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(error_text)?;
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        let error = last_error("CreateJobObjectW(commit-file)");
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut limits: JobObjectExtendedLimitInformation = unsafe { zeroed() };
    limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            (&limits as *const JobObjectExtendedLimitInformation).cast(),
            size_of::<JobObjectExtendedLimitInformation>() as u32,
        ) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
    } {
        let error = last_error("configure commit-file Job Object");
        let _ = child.kill();
        let _ = child.wait();
        unsafe { CloseHandle(job) };
        return Err(error);
    }
    let write_result = child
        .stdin
        .take()
        .ok_or("commit-file helper stdin unavailable")?
        .write_all(&request);
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        unsafe { CloseHandle(job) };
        return Err(error_text(error));
    }
    let status = child.wait().map_err(error_text)?;
    unsafe { CloseHandle(job) };
    if status.success() {
        Ok(())
    } else {
        Err(format!("trusted file-commit helper failed with {status}"))
    }
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
    let mut metadata_root = None;
    let mut generation = 0;
    let mut read_roots = Vec::new();
    let mut write_roots = Vec::new();
    let mut read_files = Vec::new();
    let mut write_files = Vec::new();
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
            "--metadata-root" => metadata_root = Some(PathBuf::from(value)),
            "--generation" => generation = value.parse().map_err(|_| "invalid generation")?,
            "--read-root" => read_roots.push(PathBuf::from(value)),
            "--write-root" => write_roots.push(PathBuf::from(value)),
            "--read-file" => read_files.push(PathBuf::from(value)),
            "--write-file" => write_files.push(PathBuf::from(value)),
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
        metadata_root,
        scratch: scratch.ok_or("missing --scratch")?,
        control_root: control_root.ok_or("missing --control-root")?,
        generation,
        read_roots,
        write_roots,
        read_files,
        write_files,
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
    exact_metadata_grants: HashSet<(u32, u64)>,
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
            exact_metadata_grants: HashSet::new(),
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

    fn grant_exact(&mut self, path: &Path, sid: &str, rights: &str) -> Result<(), String> {
        assert_not_reparse_point(path)?;
        let path_text = path.to_string_lossy().to_string();
        self.record("acl", &path_text, sid)?;
        // No (OI)/(CI): a file or ancestor directory grant must never flow to siblings.
        let grant = format!("*{sid}:({rights})");
        run_icacls("grant-exact", [&path_text, "/grant", &grant, "/L"])
    }

    fn grant_exact_metadata(
        &mut self,
        path: &Path,
        identity: (u32, u64),
        sid: &str,
    ) -> Result<(), String> {
        if self.exact_metadata_grants.contains(&identity) {
            return Ok(());
        }
        self.grant_exact(path, sid, "X,RA,RC,S")?;
        self.exact_metadata_grants.insert(identity);
        Ok(())
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

fn grant_exact_file(
    journal: &mut RecoveryJournal,
    policy: &Policy,
    path: &Path,
    sid: &str,
    rights: &str,
    allow_missing: bool,
    guards: &mut Vec<File>,
) -> Result<(), String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(format!(
            "exact-file grant requires an absolute file path: {}",
            path.display()
        ));
    }
    if path == policy.control_root || path.starts_with(&policy.control_root) {
        return Err("exact-file grant overlaps the broker control directory".into());
    }
    let parent = path.parent().ok_or("exact-file grant has no parent")?;
    let parent_info = fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "目标真实路径发生变化：精确文件父目录 {} 无法访问：{error}",
            parent.display()
        )
    })?;
    assert_not_reparse_point(parent).map_err(|error| {
        format!(
            "目标真实路径发生变化：精确文件父目录 {} 无法检查：{error}",
            parent.display()
        )
    })?;
    if !parent_info.is_dir() {
        return Err(format!(
            "exact-file parent is not a directory: {}",
            parent.display()
        ));
    }
    grant_exact_metadata_chain(journal, policy, parent, sid, guards)?;
    match fs::symlink_metadata(path) {
        Ok(info) => {
            assert_not_reparse_point(path).map_err(|error| {
                format!(
                    "目标真实路径发生变化：文件 {} 无法检查：{error}",
                    path.display()
                )
            })?;
            if !info.is_file() {
                return Err(format!(
                    "exact-file target is not a regular file: {}",
                    path.display()
                ));
            }
            let pinned = pin_path(path, false).map_err(|error| {
                format!(
                    "目标真实路径发生变化：文件 {} 无法固定：{error}",
                    path.display()
                )
            })?;
            assert_not_reparse_point(path).map_err(|error| {
                format!(
                    "目标真实路径发生变化：文件 {} 无法复核：{error}",
                    path.display()
                )
            })?;
            assert_pinned_identity(path, &pinned, false)?;
            if file_information(&pinned)?.number_of_links != 1 {
                return Err(format!(
                    "exact-file target has multiple hard links: {}",
                    path.display()
                ));
            }
            guards.push(pinned);
            journal.grant_exact(path, sid, rights)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && allow_missing => Ok(()),
        Err(error) => Err(error_text(error)),
    }
}

fn assert_pinned_identity(path: &Path, pinned: &File, directory: bool) -> Result<(), String> {
    let current = pin_path(path, directory).map_err(|error| {
        format!(
            "目标真实路径发生变化：路径 {} 无法复核：{error}",
            path.display()
        )
    })?;
    if file_identity(&current)? != file_identity(pinned)? {
        return Err(format!("目标身份已变化：精确文件路径 {}", path.display()));
    }
    Ok(())
}

fn file_identity(file: &File) -> Result<(u32, u64), String> {
    let information = file_information(file)?;
    Ok((
        information.volume_serial_number,
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low),
    ))
}

fn file_information(file: &File) -> Result<ByHandleFileInformation, String> {
    let mut information: ByHandleFileInformation = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(last_error("GetFileInformationByHandle"));
    }
    Ok(information)
}

fn current_user_profile_path() -> Result<PathBuf, String> {
    let mut token: Handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    let mut needed = 0u32;
    unsafe {
        GetUserProfileDirectoryW(token, null_mut(), &mut needed);
    }
    if needed == 0 {
        let error = last_error("GetUserProfileDirectoryW");
        unsafe { CloseHandle(token) };
        return Err(error);
    }
    let mut profile = vec![0u16; needed as usize];
    let result = unsafe { GetUserProfileDirectoryW(token, profile.as_mut_ptr(), &mut needed) };
    let error = if result == 0 {
        Some(last_error("GetUserProfileDirectoryW"))
    } else {
        None
    };
    unsafe { CloseHandle(token) };
    if let Some(error) = error {
        return Err(error);
    }
    let length = profile
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(profile.len());
    if length == 0 {
        return Err("GetUserProfileDirectoryW returned an empty path".into());
    }
    Ok(PathBuf::from(OsString::from_wide(&profile[..length])))
}

fn pin_path(path: &Path, directory: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    if directory {
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(path).map_err(error_text)
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
    let trace = std::env::var_os("PICO_SANDBOX_ACL_TRACE").is_some_and(|value| value == "1");
    let started = Instant::now();
    if trace {
        eprintln!(
            "pico-appcontainer-broker: ACL {operation} begin path={:?}",
            args[0]
        );
    }
    let _mutation_guard = AclMutationGuard::acquire()?;
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
    if trace {
        eprintln!(
            "pico-appcontainer-broker: ACL {operation} end path={:?} elapsed_ms={} status={status}",
            args[0],
            started.elapsed().as_millis()
        );
    }
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

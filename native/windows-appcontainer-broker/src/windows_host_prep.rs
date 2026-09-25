use std::ffi::{c_void, OsStr};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

#[path = "windows_network.rs"]
mod windows_network;

type Handle = *mut c_void;
type Sid = *mut c_void;
type SecurityDescriptor = *mut c_void;

pub const TARGET_SDDL: &str = "O:BAG:SYD:(A;;GRGWGX;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;RC)(A;;GRGWGX;;;AC)(A;;GRGWGX;;;S-1-15-2-2)S:(ML;;NW;;;LW)";

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const GENERIC_EXECUTE: u32 = 0x2000_0000;
const GENERIC_ALL: u32 = 0x1000_0000;
const FILE_GENERIC_READ: u32 = 0x0012_0089;
const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
const FILE_GENERIC_EXECUTE: u32 = 0x0012_00a0;
const FILE_ALL_ACCESS: u32 = 0x001f_01ff;
const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;
const WRITE_OWNER: u32 = 0x0008_0000;
const ACCESS_SYSTEM_SECURITY: u32 = 0x0100_0000;
const FILE_SHARE_READ: u32 = 0x1;
const FILE_SHARE_WRITE: u32 = 0x2;
const FILE_SHARE_DELETE: u32 = 0x4;
const OPEN_EXISTING: u32 = 3;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_PRIVILEGES: u32 = 0x0020;
const TOKEN_ELEVATION_CLASS: u32 = 20;
const SE_PRIVILEGE_ENABLED: u32 = 0x2;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const ERROR_NOT_ALL_ASSIGNED: u32 = 1300;
const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
const GROUP_SECURITY_INFORMATION: u32 = 0x0000_0002;
const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
const SACL_SECURITY_INFORMATION: u32 = 0x0000_0008;
const LABEL_SECURITY_INFORMATION: u32 = 0x0000_0010;
const TARGET_SECURITY_INFORMATION: u32 = OWNER_SECURITY_INFORMATION
    | GROUP_SECURITY_INFORMATION
    | DACL_SECURITY_INFORMATION
    | SACL_SECURITY_INFORMATION
    | LABEL_SECURITY_INFORMATION;
const SDDL_REVISION_1: u32 = 1;
const SYNCHRONIZE: u32 = 0x0010_0000;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x0000_1000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 0x0000_0102;
const ERROR_ALREADY_EXISTS: u32 = 183;
const NETWORK_MUTEX_SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00100001;;;AU)";

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    security_descriptor: SecurityDescriptor,
    inherit_handle: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Luid {
    low_part: u32,
    high_part: i32,
}

#[repr(C)]
struct LuidAndAttributes {
    luid: Luid,
    attributes: u32,
}

#[repr(C)]
struct TokenPrivileges {
    privilege_count: u32,
    privileges: [LuidAndAttributes; 1],
}

#[repr(C)]
struct TokenElevation {
    token_is_elevated: u32,
}

#[repr(C)]
struct Acl {
    revision: u8,
    sbz1: u8,
    acl_size: u16,
    ace_count: u16,
    sbz2: u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *const c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: Handle,
    ) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn GetLastError() -> u32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn SetLastError(error: u32);
    fn GetCurrentProcessId() -> u32;
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetProcessTimes(
        process: Handle,
        creation_time: *mut FileTime,
        exit_time: *mut FileTime,
        kernel_time: *mut FileTime,
        user_time: *mut FileTime,
    ) -> i32;
    fn CreateMutexW(
        attributes: *const SecurityAttributes,
        initial_owner: i32,
        name: *const u16,
    ) -> Handle;
}

#[link(name = "advapi32")]
extern "system" {
    fn AdjustTokenPrivileges(
        token_handle: Handle,
        disable_all_privileges: i32,
        new_state: *const TokenPrivileges,
        buffer_length: u32,
        previous_state: *mut TokenPrivileges,
        return_length: *mut u32,
    ) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string_security_descriptor: *const u16,
        string_sd_revision: u32,
        security_descriptor: *mut SecurityDescriptor,
        security_descriptor_size: *mut u32,
    ) -> i32;
    fn EqualSid(first: Sid, second: Sid) -> i32;
    fn GetAce(acl: *const Acl, ace_index: u32, ace: *mut *mut c_void) -> i32;
    fn GetKernelObjectSecurity(
        handle: Handle,
        requested_information: u32,
        security_descriptor: SecurityDescriptor,
        length: u32,
        length_needed: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorDacl(
        security_descriptor: SecurityDescriptor,
        dacl_present: *mut i32,
        dacl: *mut *mut Acl,
        dacl_defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorGroup(
        security_descriptor: SecurityDescriptor,
        group: *mut Sid,
        group_defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorOwner(
        security_descriptor: SecurityDescriptor,
        owner: *mut Sid,
        owner_defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorSacl(
        security_descriptor: SecurityDescriptor,
        sacl_present: *mut i32,
        sacl: *mut *mut Acl,
        sacl_defaulted: *mut i32,
    ) -> i32;
    fn GetTokenInformation(
        token_handle: Handle,
        token_information_class: u32,
        token_information: *mut c_void,
        token_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
    fn LookupPrivilegeValueW(system_name: *const u16, name: *const u16, luid: *mut Luid) -> i32;
    fn OpenProcessToken(
        process_handle: Handle,
        desired_access: u32,
        token_handle: *mut Handle,
    ) -> i32;
    fn SetKernelObjectSecurity(
        handle: Handle,
        security_information: u32,
        security_descriptor: SecurityDescriptor,
    ) -> i32;
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Command {
    Prepare {
        json: bool,
    },
    Verify {
        json: bool,
    },
    ServeTaskNetwork {
        profile_name: String,
        control_root: PathBuf,
        host_pid: u32,
    },
}

#[derive(Debug)]
struct HostPrepError {
    exit_code: i32,
    message: String,
}

impl HostPrepError {
    fn new(exit_code: i32, message: impl Into<String>) -> Self {
        Self {
            exit_code,
            message: message.into(),
        }
    }

    fn last(exit_code: i32, operation: &str) -> Self {
        Self::new(
            exit_code,
            format!("{operation} failed with Win32 error {}", unsafe {
                GetLastError()
            }),
        )
    }
}

struct OwnedHandle(Handle);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != invalid_handle() && !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

enum SecurityDescriptorStorage {
    Local,
    Buffer(Vec<u8>),
}

struct OwnedSecurityDescriptor {
    pointer: SecurityDescriptor,
    storage: SecurityDescriptorStorage,
}

impl OwnedSecurityDescriptor {
    fn from_local(pointer: SecurityDescriptor) -> Self {
        Self {
            pointer,
            storage: SecurityDescriptorStorage::Local,
        }
    }

    fn from_buffer(mut buffer: Vec<u8>) -> Self {
        let pointer = buffer.as_mut_ptr().cast();
        Self {
            pointer,
            storage: SecurityDescriptorStorage::Buffer(buffer),
        }
    }
}

impl Drop for OwnedSecurityDescriptor {
    fn drop(&mut self) {
        match &mut self.storage {
            SecurityDescriptorStorage::Local => unsafe {
                LocalFree(self.pointer);
            },
            SecurityDescriptorStorage::Buffer(buffer) => {
                let _ = buffer.len();
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AclSignature {
    Absent,
    Null,
    Present(Vec<Vec<u8>>),
}

pub fn run() -> i32 {
    let command = match parse_command(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("pico-appcontainer-host-prep: {}", error.message);
            print_usage();
            return error.exit_code;
        }
    };
    if let Err(error) = require_elevated() {
        eprintln!("pico-appcontainer-host-prep: {}", error.message);
        return error.exit_code;
    }

    let (result, json, operation, profile_name) = match &command {
        Command::Prepare { json } => (
            prepare_null_device().map(PrepareResult::label),
            *json,
            "prepare-null-device",
            None,
        ),
        Command::Verify { json } => (
            verify_null_device().map(VerifyResult::label),
            *json,
            "verify-null-device",
            None,
        ),
        Command::ServeTaskNetwork {
            profile_name,
            control_root,
            host_pid,
        } => (
            serve_task_network(profile_name, control_root, *host_pid)
                .map(|()| "revoked")
                .map_err(|message| HostPrepError::new(4, message)),
            false,
            "serve-task-network",
            Some(profile_name),
        ),
    };
    match result {
        Ok(label) => {
            if json {
                match profile_name {
                    Some(profile_name) => println!(
                        r#"{{"op":"{operation}","result":"{label}","profileName":"{profile_name}"}}"#
                    ),
                    None => println!(r#"{{"op":"{operation}","result":"{label}"}}"#),
                }
            } else {
                println!("{operation}: {label}");
            }
            if label == "drift" {
                1
            } else {
                0
            }
        }
        Err(error) => {
            eprintln!("pico-appcontainer-host-prep: {}", error.message);
            error.exit_code
        }
    }
}

fn parse_command(args: impl IntoIterator<Item = String>) -> Result<Command, HostPrepError> {
    let mut args = args.into_iter();
    let operation = args
        .next()
        .ok_or_else(|| HostPrepError::new(64, "missing operation"))?;
    let mut json = false;
    let mut profile_name = None;
    let mut control_root = None;
    let mut host_pid = None;
    while let Some(argument) = args.next() {
        if argument == "--json" && !json {
            json = true;
        } else if profile_name.is_none() && argument == "--profile-name" {
            profile_name = Some(
                args.next()
                    .ok_or_else(|| HostPrepError::new(64, "missing --profile-name value"))?,
            );
        } else if control_root.is_none() && argument == "--control-root" {
            control_root =
                Some(PathBuf::from(args.next().ok_or_else(|| {
                    HostPrepError::new(64, "missing --control-root value")
                })?));
        } else if host_pid.is_none() && argument == "--host-pid" {
            host_pid = Some(
                args.next()
                    .ok_or_else(|| HostPrepError::new(64, "missing --host-pid value"))?
                    .parse::<u32>()
                    .map_err(|_| HostPrepError::new(64, "invalid --host-pid"))?,
            );
        } else {
            return Err(HostPrepError::new(
                64,
                format!("unknown argument: {argument}"),
            ));
        }
    }
    match operation.as_str() {
        "prepare-null-device"
            if profile_name.is_none() && control_root.is_none() && host_pid.is_none() =>
        {
            Ok(Command::Prepare { json })
        }
        "verify-null-device"
            if profile_name.is_none() && control_root.is_none() && host_pid.is_none() =>
        {
            Ok(Command::Verify { json })
        }
        "serve-task-network" if !json => {
            let profile_name =
                profile_name.ok_or_else(|| HostPrepError::new(64, "missing --profile-name"))?;
            windows_network::validate_profile_name(&profile_name)
                .map_err(|message| HostPrepError::new(64, message))?;
            let control_root =
                control_root.ok_or_else(|| HostPrepError::new(64, "missing --control-root"))?;
            let host_pid = host_pid.ok_or_else(|| HostPrepError::new(64, "missing --host-pid"))?;
            if host_pid == 0 || !control_root.is_absolute() || !control_root.is_dir() {
                return Err(HostPrepError::new(
                    64,
                    "invalid task network lifetime parameters",
                ));
            }
            Ok(Command::ServeTaskNetwork {
                profile_name,
                control_root,
                host_pid,
            })
        }
        _ => Err(HostPrepError::new(
            64,
            format!("unknown operation: {operation}"),
        )),
    }
}

fn print_usage() {
    eprintln!(
        "usage: pico-appcontainer-host-prep <prepare-null-device|verify-null-device|serve-task-network> [--profile-name NAME] [--control-root ROOT] [--host-pid PID] [--json]"
    );
}

#[derive(Clone, Copy)]
enum PrepareResult {
    Applied,
    NoChange,
}

impl PrepareResult {
    fn label(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NoChange => "no-change",
        }
    }
}

#[derive(Clone, Copy)]
enum VerifyResult {
    Match,
    Drift,
}

impl VerifyResult {
    fn label(self) -> &'static str {
        match self {
            Self::Match => "match",
            Self::Drift => "drift",
        }
    }
}

fn serve_task_network(
    profile_name: &str,
    control_root: &Path,
    host_pid: u32,
) -> Result<(), String> {
    let host = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, host_pid) };
    if host.is_null() {
        return Err(format!("cannot open task Host process: {}", unsafe {
            GetLastError()
        }));
    }
    let host = OwnedHandle(host);
    if unsafe { WaitForSingleObject(host.0, 0) } != WAIT_TIMEOUT {
        return Err("task Host exited before network preparation".into());
    }
    let mutex_sddl = wide_null(NETWORK_MUTEX_SDDL);
    let mut descriptor: SecurityDescriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            mutex_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(format!("cannot create task helper mutex ACL: {}", unsafe {
            GetLastError()
        }));
    }
    let descriptor = OwnedSecurityDescriptor::from_local(descriptor);
    let security = SecurityAttributes {
        length: size_of::<SecurityAttributes>() as u32,
        security_descriptor: descriptor.pointer,
        inherit_handle: 0,
    };
    let mutex_name = windows_network::helper_mutex_name(profile_name)?;
    let mutex_wide = wide_null(mutex_name);
    let mutex = unsafe { CreateMutexW(&security, 1, mutex_wide.as_ptr()) };
    if mutex.is_null() {
        return Err(format!("cannot create task helper mutex: {}", unsafe {
            GetLastError()
        }));
    }
    let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let _mutex = OwnedHandle(mutex);
    if already_exists {
        return Err("task network helper is already active".into());
    }
    let ready = control_root.join(format!("network-{profile_name}.ready"));
    let revoke = control_root.join(format!("network-{profile_name}.revoke"));
    let revoked = control_root.join(format!("network-{profile_name}.revoked"));
    windows_network::set_loopback_exempt(profile_name, true)?;
    let run = (|| -> Result<(), String> {
        let started_at = current_process_started_at()?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&ready)
            .map_err(|error| format!("cannot publish task network helper state: {error}"))?;
        write!(
            file,
            "{}:{}:{}",
            unsafe { GetCurrentProcessId() },
            started_at,
            host_pid
        )
        .map_err(|error| format!("cannot write task network helper state: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot persist task network helper state: {error}"))?;
        loop {
            if revoke.exists() {
                break;
            }
            match unsafe { WaitForSingleObject(host.0, 250) } {
                WAIT_TIMEOUT => continue,
                WAIT_OBJECT_0 => break,
                status => return Err(format!("task Host lifetime wait failed: 0x{status:08x}")),
            }
        }
        Ok(())
    })();
    let _ = fs::remove_file(&ready);
    let cleanup = windows_network::set_loopback_exempt(profile_name, false);
    if cleanup.is_ok() {
        let _ = fs::remove_file(&revoke);
        fs::write(&revoked, b"revoked")
            .map_err(|error| format!("cannot publish task network revocation: {error}"))?;
    }
    run?;
    cleanup?;
    Ok(())
}

fn current_process_started_at() -> Result<u64, String> {
    let mut creation: FileTime = unsafe { zeroed() };
    let mut exit: FileTime = unsafe { zeroed() };
    let mut kernel: FileTime = unsafe { zeroed() };
    let mut user: FileTime = unsafe { zeroed() };
    if unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(format!("GetProcessTimes failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok((u64::from(creation.high_date_time) << 32) | u64::from(creation.low_date_time))
}

fn prepare_null_device() -> Result<PrepareResult, HostPrepError> {
    enable_privilege("SeSecurityPrivilege")?;
    let target = parse_target_descriptor()?;
    let handle = open_null(true)?;
    let current = read_descriptor(handle.0)?;
    if descriptors_equal(&current, &target)? {
        return Ok(PrepareResult::NoChange);
    }
    if unsafe { SetKernelObjectSecurity(handle.0, TARGET_SECURITY_INFORMATION, target.pointer) }
        == 0
    {
        return Err(HostPrepError::last(
            4,
            "SetKernelObjectSecurity(\\Device\\Null)",
        ));
    }
    let verified = read_descriptor(handle.0)?;
    if !descriptors_equal(&verified, &target)? {
        return Err(HostPrepError::new(
            4,
            "\\Device\\Null security descriptor did not match after the atomic write",
        ));
    }
    Ok(PrepareResult::Applied)
}

fn verify_null_device() -> Result<VerifyResult, HostPrepError> {
    enable_privilege("SeSecurityPrivilege")?;
    let target = parse_target_descriptor()?;
    let handle = open_null(false)?;
    let current = read_descriptor(handle.0)?;
    Ok(if descriptors_equal(&current, &target)? {
        VerifyResult::Match
    } else {
        VerifyResult::Drift
    })
}

fn require_elevated() -> Result<(), HostPrepError> {
    let token = open_process_token(TOKEN_QUERY, 65)?;
    let mut elevation: TokenElevation = unsafe { zeroed() };
    let mut returned = 0u32;
    if unsafe {
        GetTokenInformation(
            token.0,
            TOKEN_ELEVATION_CLASS,
            (&mut elevation as *mut TokenElevation).cast(),
            size_of::<TokenElevation>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(HostPrepError::last(
            65,
            "GetTokenInformation(TokenElevation)",
        ));
    }
    if elevation.token_is_elevated == 0 {
        return Err(HostPrepError::new(
            65,
            "an elevated administrator token is required; the runtime broker never self-elevates",
        ));
    }
    Ok(())
}

fn enable_privilege(name: &str) -> Result<(), HostPrepError> {
    let token = open_process_token(TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, 3)?;
    let name = wide_null(name);
    let mut luid: Luid = unsafe { zeroed() };
    if unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) } == 0 {
        return Err(HostPrepError::last(
            3,
            "LookupPrivilegeValueW(SeSecurityPrivilege)",
        ));
    }
    let privileges = TokenPrivileges {
        privilege_count: 1,
        privileges: [LuidAndAttributes {
            luid,
            attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    unsafe { SetLastError(0) };
    if unsafe { AdjustTokenPrivileges(token.0, 0, &privileges, 0, null_mut(), null_mut()) } == 0 {
        return Err(HostPrepError::last(
            3,
            "AdjustTokenPrivileges(SeSecurityPrivilege)",
        ));
    }
    if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
        return Err(HostPrepError::new(
            3,
            "the elevated token does not hold SeSecurityPrivilege",
        ));
    }
    Ok(())
}

fn open_process_token(access: u32, exit_code: i32) -> Result<OwnedHandle, HostPrepError> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) } == 0 {
        Err(HostPrepError::last(exit_code, "OpenProcessToken"))
    } else {
        Ok(OwnedHandle(token))
    }
}

fn open_null(write: bool) -> Result<OwnedHandle, HostPrepError> {
    let mut access = GENERIC_READ | READ_CONTROL | ACCESS_SYSTEM_SECURITY;
    if write {
        access |= WRITE_DAC | WRITE_OWNER;
    }
    let path = wide_null(r"\\.\NUL");
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == invalid_handle() {
        Err(HostPrepError::last(2, "CreateFileW(\\\\.\\NUL)"))
    } else {
        Ok(OwnedHandle(handle))
    }
}

fn parse_target_descriptor() -> Result<OwnedSecurityDescriptor, HostPrepError> {
    let target = wide_null(TARGET_SDDL);
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            target.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
        || descriptor.is_null()
    {
        Err(HostPrepError::last(
            5,
            "ConvertStringSecurityDescriptorToSecurityDescriptorW(target)",
        ))
    } else {
        Ok(OwnedSecurityDescriptor::from_local(descriptor))
    }
}

fn read_descriptor(handle: Handle) -> Result<OwnedSecurityDescriptor, HostPrepError> {
    let mut needed = 0u32;
    let probe = unsafe {
        GetKernelObjectSecurity(
            handle,
            TARGET_SECURITY_INFORMATION,
            null_mut(),
            0,
            &mut needed,
        )
    };
    if probe == 0 && unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(HostPrepError::last(
            1,
            "GetKernelObjectSecurity(\\Device\\Null size)",
        ));
    }
    if needed == 0 {
        return Err(HostPrepError::new(
            1,
            "GetKernelObjectSecurity returned an empty descriptor",
        ));
    }
    let mut buffer = vec![0u8; needed as usize];
    if unsafe {
        GetKernelObjectSecurity(
            handle,
            TARGET_SECURITY_INFORMATION,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(HostPrepError::last(
            1,
            "GetKernelObjectSecurity(\\Device\\Null)",
        ));
    }
    Ok(OwnedSecurityDescriptor::from_buffer(buffer))
}

fn descriptors_equal(
    current: &OwnedSecurityDescriptor,
    target: &OwnedSecurityDescriptor,
) -> Result<bool, HostPrepError> {
    if !component_sid_equal(current.pointer, target.pointer, true)?
        || !component_sid_equal(current.pointer, target.pointer, false)?
    {
        return Ok(false);
    }
    Ok(
        acl_signature(current.pointer, false)? == acl_signature(target.pointer, false)?
            && acl_signature(current.pointer, true)? == acl_signature(target.pointer, true)?,
    )
}

fn component_sid_equal(
    current: SecurityDescriptor,
    target: SecurityDescriptor,
    owner: bool,
) -> Result<bool, HostPrepError> {
    let mut current_sid = null_mut();
    let mut target_sid = null_mut();
    let mut defaulted = 0;
    let current_ok = unsafe {
        if owner {
            GetSecurityDescriptorOwner(current, &mut current_sid, &mut defaulted)
        } else {
            GetSecurityDescriptorGroup(current, &mut current_sid, &mut defaulted)
        }
    };
    let target_ok = unsafe {
        if owner {
            GetSecurityDescriptorOwner(target, &mut target_sid, &mut defaulted)
        } else {
            GetSecurityDescriptorGroup(target, &mut target_sid, &mut defaulted)
        }
    };
    if current_ok == 0 || target_ok == 0 {
        return Err(HostPrepError::last(
            1,
            if owner {
                "GetSecurityDescriptorOwner"
            } else {
                "GetSecurityDescriptorGroup"
            },
        ));
    }
    if current_sid.is_null() || target_sid.is_null() {
        Ok(current_sid == target_sid)
    } else {
        Ok(unsafe { EqualSid(current_sid, target_sid) } != 0)
    }
}

fn acl_signature(
    descriptor: SecurityDescriptor,
    sacl: bool,
) -> Result<AclSignature, HostPrepError> {
    let mut present = 0;
    let mut acl = null_mut();
    let mut defaulted = 0;
    let ok = unsafe {
        if sacl {
            GetSecurityDescriptorSacl(descriptor, &mut present, &mut acl, &mut defaulted)
        } else {
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
        }
    };
    if ok == 0 {
        return Err(HostPrepError::last(
            1,
            if sacl {
                "GetSecurityDescriptorSacl"
            } else {
                "GetSecurityDescriptorDacl"
            },
        ));
    }
    if present == 0 {
        return Ok(AclSignature::Absent);
    }
    if acl.is_null() {
        return Ok(AclSignature::Null);
    }
    let mut aces = Vec::with_capacity(unsafe { (*acl).ace_count } as usize);
    for index in 0..unsafe { (*acl).ace_count } {
        let mut ace = null_mut();
        if unsafe { GetAce(acl, u32::from(index), &mut ace) } == 0 || ace.is_null() {
            return Err(HostPrepError::last(1, "GetAce"));
        }
        let size =
            unsafe { u16::from_le_bytes([*(ace.cast::<u8>().add(2)), *(ace.cast::<u8>().add(3))]) }
                as usize;
        if size < 4 {
            return Err(HostPrepError::new(
                1,
                "security descriptor contains a truncated ACE",
            ));
        }
        let mut bytes = unsafe { std::slice::from_raw_parts(ace.cast::<u8>(), size) }.to_vec();
        normalize_ace(&mut bytes);
        aces.push(bytes);
    }
    aces.sort_unstable();
    Ok(AclSignature::Present(aces))
}

fn normalize_ace(ace: &mut [u8]) {
    if ace.len() < 8 {
        return;
    }
    let mask = u32::from_le_bytes([ace[4], ace[5], ace[6], ace[7]]);
    ace[4..8].copy_from_slice(&normalize_access_mask(mask).to_le_bytes());
}

fn normalize_access_mask(mut mask: u32) -> u32 {
    for (generic, specific) in [
        (GENERIC_READ, FILE_GENERIC_READ),
        (GENERIC_WRITE, FILE_GENERIC_WRITE),
        (GENERIC_EXECUTE, FILE_GENERIC_EXECUTE),
        (GENERIC_ALL, FILE_ALL_ACCESS),
    ] {
        if mask & generic != 0 {
            mask = (mask & !generic) | specific;
        }
    }
    mask
}

fn invalid_handle() -> Handle {
    (-1isize) as Handle
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{normalize_access_mask, normalize_ace, parse_command, Command, TARGET_SDDL};

    #[test]
    fn target_sddl_is_the_reviewed_appcontainer_null_device_descriptor() {
        assert_eq!(
            TARGET_SDDL,
            "O:BAG:SYD:(A;;GRGWGX;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;RC)(A;;GRGWGX;;;AC)(A;;GRGWGX;;;S-1-15-2-2)S:(ML;;NW;;;LW)"
        );
    }

    #[test]
    fn generic_file_rights_normalize_to_the_kernel_persisted_mask() {
        assert_eq!(
            normalize_access_mask(0xe000_0000),
            0x0012_01bf,
            "GR|GW|GX must match the IoFileObjectType persisted mask"
        );
        let mut ace = vec![0, 0, 8, 0, 0, 0, 0, 0xe0];
        normalize_ace(&mut ace);
        assert_eq!(&ace[4..8], &0x0012_01bfu32.to_le_bytes());
    }

    #[test]
    fn command_parser_has_only_explicit_null_device_operations() {
        assert_eq!(
            parse_command(["prepare-null-device".into(), "--json".into()]).unwrap(),
            Command::Prepare { json: true }
        );
        assert_eq!(
            parse_command(["verify-null-device".into()]).unwrap(),
            Command::Verify { json: false }
        );
        assert!(parse_command(["prepare-system-drive".into()]).is_err());
        assert!(parse_command([
            "prepare-null-device".into(),
            "--json".into(),
            "--json".into()
        ])
        .is_err());
    }
}

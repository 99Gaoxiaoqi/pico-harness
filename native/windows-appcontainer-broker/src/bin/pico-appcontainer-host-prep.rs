#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
#[path = "../windows_host_prep.rs"]
mod windows_host_prep;

#[cfg(windows)]
fn main() {
    std::process::exit(windows_host_prep::run());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("pico-appcontainer-host-prep is only supported on Windows");
    std::process::exit(1);
}

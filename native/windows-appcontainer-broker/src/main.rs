#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    if let Err(error) = windows::run() {
        eprintln!("pico-appcontainer-broker: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("pico-appcontainer-broker is only supported on Windows");
    std::process::exit(1);
}

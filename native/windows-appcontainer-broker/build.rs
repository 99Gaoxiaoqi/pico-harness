use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=pico-appcontainer-host-prep.manifest");
    println!("cargo:rerun-if-env-changed=PROFILE");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("PROFILE").as_deref() != Ok("release")
    {
        return;
    }

    let manifest = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"),
    )
    .join("pico-appcontainer-host-prep.manifest");
    println!(
        "cargo:rustc-link-arg-bin=pico-appcontainer-host-prep=/MANIFESTINPUT:{}",
        manifest.display()
    );
    println!("cargo:rustc-link-arg-bin=pico-appcontainer-host-prep=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-bin=pico-appcontainer-host-prep=/MANIFESTUAC:level='requireAdministrator'"
    );
}

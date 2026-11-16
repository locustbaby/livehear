fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && let Ok(out_dir) = std::env::var("OUT_DIR")
    {
        let out_path = std::path::Path::new(&out_dir);
        let resource_lib = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            out_path.join("resource.lib")
        } else {
            out_path.join("libresource.a")
        };
        if resource_lib.exists() {
            println!("cargo:rustc-link-arg-tests={}", resource_lib.display());
        }
    }
}

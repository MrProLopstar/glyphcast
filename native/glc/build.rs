//! The icon and file details of glc.exe: a resource script compiled with the Windows SDK's rc.exe and linked in.
//! Without the SDK the exe is built anyway, just without them.
use std::path::PathBuf;

fn rc_exe() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RC") {
        return Some(PathBuf::from(path));
    }
    let kits = PathBuf::from(r"C:\Program Files (x86)\Windows Kits\10\bin");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&kits).ok()?.flatten().map(|e| e.path().join("x64").join("rc.exe")).filter(|p| p.exists()).collect();
    versions.sort();
    versions.pop()
}

fn main() {
    println!("cargo:rerun-if-changed=assets/glc.ico");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Some(rc) = rc_exe() else {
        println!("cargo:warning=rc.exe not found: glc.exe gets no icon");
        return;
    };
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let icon = std::fs::canonicalize("assets/glc.ico").unwrap();
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let numbers = version.replace('.', ",");
    let script = format!(
        "1 ICON \"{}\"\n1 VERSIONINFO FILEVERSION {numbers},0 PRODUCTVERSION {numbers},0\nBEGIN\n BLOCK \"StringFileInfo\"\n BEGIN\n  BLOCK \"040904b0\"\n  BEGIN\n   VALUE \"ProductName\", \"glyphcast\"\n   VALUE \"FileDescription\", \"glyphcast player: .gcast videos in the console\"\n   VALUE \"FileVersion\", \"{version}\"\n   VALUE \"ProductVersion\", \"{version}\"\n   VALUE \"LegalCopyright\", \"MrProLopstar, MPL-2.0\"\n   VALUE \"OriginalFilename\", \"glc.exe\"\n  END\n END\n BLOCK \"VarFileInfo\"\n BEGIN\n  VALUE \"Translation\", 0x409, 1200\n END\nEND\n",
        icon.display().to_string().trim_start_matches(r"\\?\").replace('\\', "/")
    );
    std::fs::write(out.join("glc.rc"), script).unwrap();
    let status = std::process::Command::new(rc).args(["/nologo", "/fo"]).arg(out.join("glc.res")).arg(out.join("glc.rc")).status();
    if status.map(|s| s.success()).unwrap_or(false) {
        println!("cargo:rustc-link-arg-bins={}", out.join("glc.res").display());
    } else {
        println!("cargo:warning=rc.exe failed: glc.exe gets no icon");
    }
}

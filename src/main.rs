fn main() {
    if let Err(error) = codefacts::cli::run(std::env::args_os().skip(1)) {
        eprintln!("codefacts: {error}");
        std::process::exit(2);
    }
}

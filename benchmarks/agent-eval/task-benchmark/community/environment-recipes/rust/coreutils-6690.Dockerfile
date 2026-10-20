ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.sanitation="uutils-6690 embedded repository and compiled outputs removed; third-party Cargo registry and Rust toolchain retained"
# Original inventory: selected clean HEAD and 1613 exact source files; /testbed/target=1805752 KiB.
# Preserve verified external Cargo registry (137992 KiB) and Rust 1.81.0 toolchain.
RUN cd / && rm -rf -- /testbed /root/.bashrc && mkdir -p /testbed && git config --system --add safe.directory /testbed
# Frozen sandbox bash -lc needs the already-installed Cargo toolchain on login PATH.
RUN printf '%s\n' 'export PATH="/usr/local/cargo/bin:$PATH"' > /etc/profile.d/codefacts-cargo.sh
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]

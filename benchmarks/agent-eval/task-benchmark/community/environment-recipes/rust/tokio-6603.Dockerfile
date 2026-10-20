ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.sanitation="tokio-6603 embedded repository and compiled outputs removed; third-party Cargo registry and Rust toolchain retained"
# Original inventory: clean selected HEAD and 774 exact source files; /testbed/target=511636 KiB.
# /tmp/rustix_test_can_compile is the only temporary build probe; /root/.bashrc references conda.
RUN cd / && rm -rf -- /testbed /root/.bashrc /tmp/rustix_test_can_compile && mkdir -p /testbed && git config --system --add safe.directory /testbed
# Frozen sandbox commands use bash -lc; Debian /etc/profile resets the image ENV PATH.
RUN printf '%s\n' 'export PATH="/usr/local/cargo/bin:$PATH"' > /etc/profile.d/codefacts-cargo.sh
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]

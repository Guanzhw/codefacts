ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.source-manifest="sha256:57ddad71c2bc85a20fb9e353e0012aec6ef747fd4e1744a30f20804b70acf1b6"
# Actual original inventory: embedded upstream repository, terraform.test,
# task compilation cache, and a missing Conda path in the root startup file.
RUN cd / && rm -rf -- /testbed /root/.cache/go-build /root/.bashrc && mkdir -p /testbed /root/.cache/go-build && git config --system --add safe.directory /testbed
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]

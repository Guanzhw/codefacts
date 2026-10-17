# Exact locally loaded original image. Installed dependencies and Chrome retained.
ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.sanitation="preact-3562: remove embedded repository, generated products, npm cache and startup files; retain installed dependency tree and browser toolchain"
# Observed original: 29652 installed dependency files, 101 internal valid symlinks,
# no nested preact package. Embedded workingtree package-lock setup drift is removed.
RUN cd / && find /testbed -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} + \
    && rm -rf -- /root/.npm /root/.bashrc /root/.profile /home/nonroot/.bashrc /home/nonroot/.profile /home/nonroot/.bash_logout /tmp/core-js-banners \
    && git config --system --add safe.directory /testbed
VOLUME ["/testbed/node_modules"]
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]

# Exact locally loaded original image. Installed dependencies and Chrome retained.
ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.sanitation="preact-3010: remove embedded repository, generated products, npm cache and startup files; retain installed dependency tree and browser toolchain"
# Observed original: 97 valid links, 96 internal and one node-gyp python link
# to installed /usr/bin/python3 -> /usr/bin/python3.10. No nested preact package.
RUN cd / && find /testbed -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} + \
    && rm -rf -- /root/.npm /root/.bashrc /root/.profile /home/nonroot/.bashrc /home/nonroot/.profile /home/nonroot/.bash_logout /tmp/core-js-banners \
    && git config --system --add safe.directory /testbed
VOLUME ["/testbed/node_modules"]
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]
ENV HOME=/home/nonroot
USER 1000:1000

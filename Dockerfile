FROM habitat/default-studio-x86_64-linux:0.85.0

ARG HAB_LICENSE=accept-no-persist
ENV HAB_LICENSE=$HAB_LICENSE

RUN hab pkg install \
        core/coreutils \
        core/git \
        jarvus/hologit

RUN hab pkg binlink core/git \
    && hab pkg binlink jarvus/hologit

RUN hab pkg exec core/coreutils mkdir -m 1777 -p /tmp \
    && hab pkg exec core/coreutils mkdir -m 0750 -p /root

ENV STUDIO_TYPE=action

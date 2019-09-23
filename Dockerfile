FROM habitat/default-studio-x86_64-linux:0.85.0

ARG HAB_LICENSE=accept-no-persist
ENV HAB_LICENSE=$HAB_LICENSE

RUN hab pkg install \
    --binlink \
    core/git \
    jarvus/hologit

COPY entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

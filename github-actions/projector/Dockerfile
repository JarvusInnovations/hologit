FROM habitat/default-studio-x86_64-linux:0.85.0

ARG HAB_LICENSE
ENV HAB_LICENSE=$HAB_LICENSE

COPY entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

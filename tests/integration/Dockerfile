FROM docker:29-dind
# setpriv and nsenter (util-linux) run the restore test's internal web check as nobody inside a copy's network.
RUN (apk add --no-cache setpriv nsenter || apk add --no-cache util-linux) \
    && apk add --no-cache python3 openssh nginx tar coreutils acl curl \
    && mkdir -p /root/.ssh /run/sshd \
    && chmod 700 /root/.ssh \
    && passwd -d root \
    && echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config \
    && echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
COPY tests/integration/start.sh /usr/local/bin/docknest-qa-start
ENTRYPOINT ["sh", "/usr/local/bin/docknest-qa-start"]

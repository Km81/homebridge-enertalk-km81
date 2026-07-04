FROM python:3-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables iproute2 conntrack \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir scapy

COPY redirect.py /redirect.py

CMD ["python", "-u", "/redirect.py"]

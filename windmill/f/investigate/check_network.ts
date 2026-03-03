// Windmill Script: Check Network (Read-Only)
// Investigation tool — DNS lookups, reverse DNS, and TLS certificate checks.
// Useful for investigating domain ownership, IP attribution, and certificate validity.

import { resolve, resolve4, resolve6, reverse, resolveMx, resolveTxt } from "node:dns/promises";
import * as tls from "node:tls";

export async function main(
  action: "dns_lookup" | "reverse_dns" | "check_certificate" | "mx_lookup" | "txt_lookup",
  target: string,
) {
  if (!target) return { error: "target is required — provide a hostname or IP address" };

  switch (action) {
    case "dns_lookup": {
      const [ipv4, ipv6] = await Promise.allSettled([
        resolve4(target),
        resolve6(target),
      ]);
      return {
        action: "dns_lookup",
        hostname: target,
        ipv4: ipv4.status === "fulfilled" ? ipv4.value : [],
        ipv6: ipv6.status === "fulfilled" ? ipv6.value : [],
      };
    }

    case "reverse_dns": {
      try {
        const hostnames = await reverse(target);
        return { action: "reverse_dns", ip: target, hostnames };
      } catch (e: any) {
        return { action: "reverse_dns", ip: target, error: e.message };
      }
    }

    case "check_certificate": {
      return new Promise((res) => {
        const socket = tls.connect({ host: target, port: 443, servername: target }, () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          res({
            action: "check_certificate",
            hostname: target,
            subject: cert.subject,
            issuer: cert.issuer,
            valid_from: cert.valid_from,
            valid_to: cert.valid_to,
            serial: cert.serialNumber,
            fingerprint: cert.fingerprint256,
            alt_names: cert.subjectaltname?.split(", "),
            authorized: socket.authorized,
          });
        });
        socket.on("error", (e) => {
          res({ action: "check_certificate", hostname: target, error: e.message });
        });
        socket.setTimeout(5000, () => {
          socket.destroy();
          res({ action: "check_certificate", hostname: target, error: "Connection timeout" });
        });
      });
    }

    case "mx_lookup": {
      try {
        const records = await resolveMx(target);
        return {
          action: "mx_lookup",
          hostname: target,
          mx_records: records.sort((a, b) => a.priority - b.priority),
        };
      } catch (e: any) {
        return { action: "mx_lookup", hostname: target, error: e.message };
      }
    }

    case "txt_lookup": {
      try {
        const records = await resolveTxt(target);
        return {
          action: "txt_lookup",
          hostname: target,
          txt_records: records.map(r => r.join("")),
        };
      } catch (e: any) {
        return { action: "txt_lookup", hostname: target, error: e.message };
      }
    }
  }
}

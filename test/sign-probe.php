<?php

declare(strict_types=1);

// Runs INSIDE the lab container (greenhouse decisions/0611 Desktop measure). It is the house: the REAL
// RemoteOperationSigner (#789), given no key, asks the host over the socket the Desktop mounted in (MILPA_SIGN_SOCKET),
// then verifies the signature with the container's PUBLIC-only keyring. Prints one JSON line the smoke reads.
//   usage: php /labtest/sign-probe.php <expected-fingerprint>
require '/app/vendor/autoload.php';

use Milpa\AppRuntime\Console\RemoteOperationSigner;
use Milpa\ToolRuntime\Identity\GnupgSignatureVerifier;

$sock = (string) getenv('MILPA_SIGN_SOCKET');
$fpr = trim((string) ($argv[1] ?? ''));

$signer = new RemoteOperationSigner($sock, approvalSeconds: 30);
$signed = $signer->sign('capabilities:enable', ['capability' => 'milpa/admin'], 'labhouse', time());

if ($signed === null) {
    $why = $signer->whyNotSigned();
    echo json_encode(['signed' => false, 'reason' => $why?->reason]) . "\n";
    exit(0);
}

[$payload, $signature] = $signed;
$doc = json_decode($payload, true);
putenv('GNUPGHOME=/root/.gnupg');
$verified = (new GnupgSignatureVerifier())->verify($payload, $signature);
$secret = (int) preg_match('/^sec/m', (string) shell_exec('gpg --list-secret-keys --with-colons 2>/dev/null'));

echo json_encode([
    'signed' => true,
    'operation' => $doc['operation'] ?? null,
    'arguments' => $doc['arguments'] ?? null,
    'host' => $doc['host'] ?? null,
    'issuedAt' => $doc['issuedAt'] ?? null,
    'has_nonce' => isset($doc['nonce']) && is_string($doc['nonce']) && $doc['nonce'] !== '',
    'verified' => $verified !== null,
    'fpr_matches' => $verified !== null && $verified->fingerprint === $fpr,
    'container_secret_keys' => $secret,
]) . "\n";

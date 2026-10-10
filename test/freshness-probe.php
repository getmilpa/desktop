<?php

declare(strict_types=1);

// Runs INSIDE the lab container (greenhouse decisions/0611 review, point 5). It gets a REAL signature from the host
// signer over the socket, then asks the house's OperationAuthorizer whether that authorization is still fresh at two
// clocks — 90s and 121s after the issuedAt the host stamped. The authorizer's freshness window is 120s (its default,
// which app-runtime does not change), so 121s must be rejected. This confirms, by execution, the dead zone a too-long
// approval would fall into. The clock is injected, so no real waiting.
//   usage: php /labtest/freshness-probe.php
require '/app/vendor/autoload.php';

use Milpa\AppRuntime\Console\RemoteOperationSigner;
use Milpa\ToolRuntime\Identity\FileNonceLedger;
use Milpa\ToolRuntime\Identity\GnupgSignatureVerifier;
use Milpa\ToolRuntime\Identity\OperationAuthorizer;

$sock = (string) getenv('MILPA_SIGN_SOCKET');
$op = 'capabilities:enable';
$args = ['capability' => 'milpa/admin'];
$host = 'labhouse';

$signer = new RemoteOperationSigner($sock, approvalSeconds: 30);
$signed = $signer->sign($op, $args, $host, time());
if ($signed === null) {
    echo json_encode(['signed' => false, 'reason' => $signer->whyNotSigned()?->reason]) . "\n";
    exit(0);
}
[$payload, $signature] = $signed;
$doc = json_decode($payload, true);
$issued = strtotime((string) ($doc['issuedAt'] ?? '')); // epoch of what the host stamped and signed

putenv('GNUPGHOME=/root/.gnupg'); // the container's public-only keyring
$authorizerAt = static function (): OperationAuthorizer {
    $dir = sys_get_temp_dir() . '/nonce-' . bin2hex(random_bytes(4));
    @mkdir($dir, 0700, true);

    return new OperationAuthorizer(new GnupgSignatureVerifier(), new FileNonceLedger($dir), 120);
};

$at90 = $authorizerAt()->authorize($op, $args, $host, $payload, $signature, $issued + 90);
$at121 = $authorizerAt()->authorize($op, $args, $host, $payload, $signature, $issued + 121);

echo json_encode([
    'signed' => true,
    'granted_at_90s' => $at90->granted,
    'reason_90' => $at90->reason,
    'granted_at_121s' => $at121->granted,
    'reason_121' => $at121->reason,
]) . "\n";

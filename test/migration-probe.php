<?php

declare(strict_types=1);

// MIGRATION after a compromised signing key (greenhouse decisions/0611 review, item 3). A house was founded with key
// A, rooted out of band. The patched Desktop treats A as compromised and generates B in a NEW keyring A never shared.
// Can B take over WITHOUT A? Measured against the REAL identity classes (app-runtime), by execution.
//   usage: php migration-probe.php <appRoot> <fingerprintA> <fingerprintB>
require '/app/vendor/autoload.php';

use Milpa\AppRuntime\Identity\IdentityEnrollment;
use Milpa\AppRuntime\Identity\IdentityInvitations;
use Milpa\AppRuntime\Identity\IdentityNotRooted;

[$root, $A, $B] = [$argv[1], trim($argv[2]), trim($argv[3])];
@mkdir($root . '/config', 0700, true);
@mkdir($root . '/storage/identity', 0700, true);

$out = [];

// 1) The house as it was: config/identity.php roots A (the founder) only.
file_put_contents($root . '/config/identity.php', "<?php\n\nreturn ['rooted' => ['" . $A . "']];\n");
$rootA = IdentityInvitations::rootFor($root);
$out['A_is_rooted'] = $rootA->admits($A);
$out['B_is_rooted_before'] = $rootA->admits($B);

// 2) Try to enroll B while A is gone and B is not rooted — the gate that decides the migration.
try {
    (new IdentityEnrollment($rootA))->enroll($B, ['milpa/admin'], 'key:' . $B);
    $out['enroll_B_without_rooting'] = 'UNEXPECTEDLY SUCCEEDED';
} catch (IdentityNotRooted $e) {
    $out['enroll_B_without_rooting'] = 'refused';
    $out['what_the_house_says'] = $e->getMessage();
}

// 3) The out-of-band recovery: the operator adds B to config/identity.php. NO A signature is involved — rooting is
//    read from config before boot, never minted by a running session (the one path left when A is unreachable).
file_put_contents($root . '/config/identity.php', "<?php\n\nreturn ['rooted' => ['" . $A . "', '" . $B . "']];\n");
$rootAB = IdentityInvitations::rootFor($root);
$out['B_is_rooted_after_config_edit'] = $rootAB->admits($B);
try {
    (new IdentityEnrollment($rootAB))->enroll($B, ['milpa/admin'], 'key:' . $B);
    $out['enroll_B_after_rooting'] = 'succeeded (no A needed)';
} catch (\Throwable $e) {
    $out['enroll_B_after_rooting'] = 'failed: ' . $e->getMessage();
}

// 4) The only OTHER way to root B needs an existing rooted signer to mint an invitation — i.e. it needs A. Stated,
//    not re-measured here: IdentityInvitations::mint() is authorized_by a principal the house already credits.
$out['other_path_needs_A'] = 'an invitation (IdentityInvitations::mint) must be authorized by an already-rooted signer';

echo json_encode($out, JSON_UNESCAPED_SLASHES) . "\n";

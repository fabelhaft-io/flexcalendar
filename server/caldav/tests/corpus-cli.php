<?php

declare(strict_types=1);

// E15-R03: expand the recurrence corpus with sabre/vobject and print the
// normalised result as JSON.
//
//   php tests/corpus-cli.php              # one JSON object of every fixture
//   php tests/corpus-cli.php <directory>  # one <id>.json per fixture
//
// `infra/scripts/corpus-compare.mjs` uses the directory form to diff the two
// engines. The expansion itself lives in `RecurrenceCorpus`, so this script and
// the PHPUnit suite cannot drift apart.

use Calflex\Tests\RecurrenceCorpus;

require __DIR__ . '/../vendor/autoload.php';

try {
    $arguments = $_SERVER['argv'] ?? [];
    $directory = is_array($arguments) && isset($arguments[1]) && is_string($arguments[1])
        ? $arguments[1]
        : null;

    if ($directory === null) {
        $corpus = [];
        foreach (RecurrenceCorpus::fixtureIds() as $id) {
            $corpus[$id] = RecurrenceCorpus::expand($id);
        }
        $json = json_encode($corpus, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new RuntimeException('Cannot encode the corpus');
        }
        echo $json, "\n";
    } else {
        foreach (RecurrenceCorpus::writeOutput($directory) as $path) {
            fwrite(STDERR, $path . "\n");
        }
    }
} catch (Throwable $error) {
    fwrite(STDERR, 'corpus-cli: ' . $error->getMessage() . "\n");
    exit(1);
}

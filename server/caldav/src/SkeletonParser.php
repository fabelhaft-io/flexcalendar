<?php

declare(strict_types=1);

namespace Calflex;

/** VObject normally stops at the first document, leaving trailing bytes unchecked. */
final class SkeletonParser extends \Sabre\VObject\Parser\MimeDir
{
    protected function parseDocument(): void
    {
        parent::parseDocument();
        try {
            $this->readLine();
        } catch (\Sabre\VObject\EofException) {
            return;
        }
        throw new SkeletonViolation('ICALENDAR');
    }
}

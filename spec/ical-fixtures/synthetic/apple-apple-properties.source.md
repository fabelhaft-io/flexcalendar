# Source — `apple-apple-properties.ics`

- **Imitates:** the vendor extensions Apple Calendar writes on a timed event: `X-APPLE-STRUCTURED-LOCATION` with the `X-APPLE-RADIUS`, `X-APPLE-REFERENCEFRAME` and `X-TITLE` parameters, `X-APPLE-TRAVEL-ADVISORY-BEHAVIOR`, and the `X-WR-ALARMUID` that names one alarm of a series.
- **Public document:** RFC 5545 § 3.8.8.2 makes an `X-` property legal and § 3.1/§ 3.2 make an `X-` parameter legal, but the names themselves are Apple's and no RFC or published Apple list naming this exact set was available to cite. **Imitates the documented format, not a capture** — captures arrive with E15-R04.
- **Invented:** every value: the UID, the alarm UID, `X-TITLE`, the radius, the zeroed geo coordinates and the `PRODID` version string. All text is neutral (`Fixture event`, `Fixture place`).

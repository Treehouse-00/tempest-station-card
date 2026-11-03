# Changelog

## 1.2.0

- **The sentence speaks like a person.** "Cool, dry and still tonight" instead of "Cool and dry tonight. Calm."; it stops calling the air dry while it rains; and it no longer reports a steady pressure, only one that is moving.
- **The Sun instrument names its moments.** "Dawn" and "Dusk" through civil twilight, "Golden hour" while the sun is within six degrees of the horizon, and "Sunrise in 24 min, at 6:37 AM" when the moment is within the hour.

## 1.1.1

- **The sentence knows the hour.** "Mild and sticky this afternoon", "Cool and dry tonight": the first clause places its reader in the day.
- **A gentler first paint.** The charts, the dial and the headlines fade in over a third of a second when history first arrives, instead of popping in. Off when the system asks for reduced motion.

## 1.1.0

- **Visual editor.** The card can be configured from the dashboard editor; every option has a field and a note.
- **A demo.** `demo/` runs the card against an invented station in a browser, with no Home Assistant needed. It is served at https://treehouse-00.github.io/tempest-station-card/demo/.
- **First-run states.** On install day the card no longer shows a high and low at the same minute, "0 min" of pressure history, or a 0.0 kWh/m² sun total before any sunlight has been recorded.
- **Calm wind.** The needle rests at Beaufort 0 instead of pointing with conviction.
- **CSV.** The table view can download its rows.
- **Lighter on Home Assistant.** The card recomputes only when one of its own entities, the forecast or the theme changes, not on every state change in the house.
- **Plain errors.** When the recorder's statistics can't be read, the card says so in words and keeps the live readings.
- **Printing** drops the controls and keeps the charts.
- **Fixes for other homes.** Hours line up with local hour boundaries in half-hour time zones; today's sunshine bar in Days and Months is what has been measured so far, not a full day of the morning's average; the recent-wind ring no longer empties in steady wind; "No rain" is not shown when there is no rain history yet; kPa and psi pressures get sensible decimals; missing units follow the home's unit system; the lightning alert speaks in km where the station does; the Today marker in Years lands on the right day late in the month.
- **Sturdier.** Changing the station or forecast in the editor starts clean; a failing statistics call is shown and retried after five minutes instead of on every redraw; nothing runs while the card is off the page; a forecast entity that appears later is picked up.
- The `elevation` option is gone: it never changed what was shown. Pressure is the station's own reading.
- Dead code and stale comments removed.

## 1.0.0

First release: the reading now in plain words with six scales, the wind dial and sun figure, and a meteogram over hours, days, months or years that fits a laptop screen.

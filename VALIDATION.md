# Hardware Validation

The addressing changes in this branch were validated against live devices, not
just unit tests. Summary of the evidence.

## Off-by-2 (custom-list) fix — standard SunSpec inverters

Reading the same point two ways: the corrected **header-address** base vs the old
**header+2** base. Header base returns physically sane values; header+2 is garbage.

### GoodWe (model 101)

| Point  | Correct (header) | Old list (header+2) |
|--------|------------------|---------------------|
| Hz     | **59.8 Hz**      | 0                   |
| PhVphA | **237 V**        | null                |
| WH     | **16307 Wh**     | -1 (sentinel)       |

### Conext XW Pro 6848 NA, standard SunSpec port 502 (model 102)

| Point  | Correct (header) | Old list (header+2) |
|--------|------------------|---------------------|
| W      | **2954 W**       | 59.79               |
| Hz     | **59.79 Hz**     | 32768 (sentinel)    |
| PhVphA | **119.26 V**     | 0                   |
| A      | **12.55 A**      | 125.9               |

The SMA Sunny Boy (model 102) confirmed the same pattern; values read null at
night (inverter asleep), which is the expected not-implemented behaviour.

## Vendor absolute-addressed models — explicit-offset fix

`pointOffset` honours explicit absolute offsets for the vendor profiles
(`modelAddr = 0`):

- **SMA EDMM (id 1):** `DeviceClass@30051 = 8128` (SMA signature), `Susyid = 356`,
  `SerialNumber = 3011599924`. A control read at the register a buggy
  accumulate-only version would have used fails — confirming the fix is required.
- **Conext XW6848, proprietary 503 (id 126):** `UniqueIDNumber@20 = 1103085`,
  `FirmwareVersion@30 = 20400`.

## Port-503 (Conext) scan fix

Default 503 scan now discovers both devices (previously the inverter at id 126 was
missed entirely), and classifies them by validating the device-name block:

```
Found Conext "cb-BC2221000287" (ID 1)        ← gateway
Found Conext "XW Pro 6848 NA" (ID 126)       ← XW Pro inverter
```

## Tests

39 unit tests (jest) pass, including offset/decode/scaling, the off-by-2
regression on the real models/index.json schema, vendor explicit-offset
handling, and the Conext device-name validator.

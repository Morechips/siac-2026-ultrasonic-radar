#include <stdint.h>

/* LM3S317 radar, V11: V10 core + AT24C02C I2C record log.
 *
 * Inherited from V10, all previously proven on this machine:
 *   - ultrasonic sequence from lm3s317_probe.c (50 cm -> 2910 us measured),
 *   - 50 Hz software servo PWM on PB0 driving full sweeps,
 *   - UART0 on PA1 at 9600 8N1 with a non-blocking transmit ring.
 *
 * Added in V11:
 *   - software I2C master on PB2 (SCL) / PB3 (SDA) for a 24C02C serial EEPROM,
 *   - one 8-byte page per measurement (31 records, rolling),
 *   - button 2 replays the stored records over the serial link.
 *
 * I2C strategy: writes never depend on reading ACK. The OLED experiments on
 * this machine showed that sampling SDA for ACK is the fragile part, and an
 * EEPROM write is fire-and-forget anyway as long as the 10 ms write time is
 * respected. Reads do sample SDA, because that is the only way to get data back.
 *
 * Wiring (LM3S317, 8 MHz):
 *   PA1  UART0 TX -> terminal / COMPIM, 9600 8N1
 *   PA2  TR       -> SRF04 TR (3)      | module VCC to 3.3V, NOT 5V
 *   PA3  ECHO     <- SRF04 ECHO (2)
 *   PB0  SERVO    -> MOTOR-PWMSERVO CTRL
 *   PB1  BUTTON1  -> GND, internal pull-up: start / stop
 *   PB5  BUTTON2  -> GND, internal pull-up: replay stored log
 *   PB2  SCL      -> 24C02C pin 6, 10k pull-up to 3.3V
 *   PB3  SDA      -> 24C02C pin 5, 10k pull-up to 3.3V
 *   24C02C: A0/A1/A2 -> GND (device address 0xA0), WP -> GND, VCC 3.3V
 *
 * Serial:
 *   SCAN,<seq>,<angle>,<mm|NA>,<OK|TIMEOUT|NO_HIT>,PROTEUS
 *   LOG,<slot>,<angle>,<mm|NA>,<status>      replay of stored records
 *   INFO,<text>
 */

#define R(a) (*(volatile uint32_t *)(a))

#define SYS_RCC   R(0x400FE060u)
#define RCGC1     R(0x400FE104u)
#define RCGC2     R(0x400FE108u)

#define PA_DATA(m) R(0x40004000u + ((m) << 2))
#define PA_DIR    R(0x40004400u)
#define PA_DEN    R(0x4000451Cu)
#define PA_AFSEL  R(0x40004420u)

#define PB_DATA(m) R(0x40005000u + ((m) << 2))
#define PB_DIR    R(0x40005400u)
#define PB_PUR    R(0x40005510u)
#define PB_DEN    R(0x4000551Cu)

#define UART_DR   R(0x4000C000u)
#define UART_FR   R(0x4000C018u)
#define UART_IBRD R(0x4000C024u)
#define UART_FBRD R(0x4000C028u)
#define UART_LCRH R(0x4000C02Cu)
#define UART_CTL  R(0x4000C030u)

#define T_CFG     R(0x40030000u)
#define T_MODE    R(0x40030004u)
#define T_CTL     R(0x4003000Cu)
#define T_LOAD    R(0x40030028u)
#define T_COUNT   R(0x40030048u)

#define TR        PA_DATA(0x04u)   /* PA2 */
#define ECHO      PA_DATA(0x08u)   /* PA3 */
#define SERVO     PB_DATA(0x01u)   /* PB0 */
/* Buttons sit on PB1/PB5 by default. Build with -DBUTTONS_ON_PA45 to move them
 * to PA4/PA5, which is useful if the PB1/PB5 pads cannot be read back on a
 * given model or board revision.
 *
 * IMPORTANT: a masked GPIODATA access returns the selected pins IN THEIR NORMAL
 * BIT POSITIONS, so a single-pin read must shift by the pin number before
 * masking. Reading `BUTTON1 & 1u` on PB1 always yields 0. */
#ifdef BUTTONS_ON_PA45
#define BUTTON1   PA_DATA(0x10u)   /* PA4, pin 21 */
#define BUTTON2   PA_DATA(0x20u)   /* PA5, pin 22 */
#define BUTTON3   PA_DATA(0x40u)   /* PA6, pin 23 */
#define B1_BIT    4u
#define B2_BIT    5u
#define B3_BIT    6u
#else
#define BUTTON1   PB_DATA(0x02u)   /* PB1, pin 30: start / stop */
#define BUTTON2   PB_DATA(0x20u)   /* PB5, pin 44: scan speed */
#define BUTTON3   PB_DATA(0x10u)   /* PB4, pin 43: replay log */
#define B1_BIT    1u
#define B2_BIT    5u
#define B3_BIT    4u
#endif
#define SCL       PB_DATA(0x04u)   /* PB2 */
#define SDA       PB_DATA(0x08u)   /* PB3 */
#define SCL_BIT   0x04u
#define SDA_BIT   0x08u
#define SDA_POS   3u

#define PB_DIR_BASE   ((1u << 0) | (1u << 2))        /* servo + SCL outputs */
#define PB_DIR_SDA_ON (PB_DIR_BASE | (1u << 3))      /* SDA driven        */
#define PB_DIR_SDA_OFF PB_DIR_BASE                   /* SDA released      */

#define TICKS_PER_US   8u
#define FRAME_US       20000u
#define FRAME_TICKS    (FRAME_US * TICKS_PER_US)
#define SLOTS_PER_STEP 4u
#define ANGLE_STEP     3u
#define ANGLE_MAX      180u
#define I2C_HALF_US    10u

#define LOG_SLOTS      31u
#define LOG_MAGIC0     0xA5u
#define LOG_MAGIC1     0x5Au

/* ------------------------------------------------------------------ timing */

static uint32_t ticks(void) { return ~T_COUNT; }
static uint32_t elapsed(uint32_t start) { return ticks() - start; }
static void wait_us(uint32_t us)
{
    uint32_t start = ticks();
    while (elapsed(start) < us * TICKS_PER_US) { }
}

/* -------------------------------------------------------------------- uart */

#define TX_SIZE 384u
static char tx_buf[TX_SIZE];
static uint32_t tx_head, tx_tail;

static void tx_push(char c)
{
    uint32_t next = (tx_head + 1u) % TX_SIZE;
    if (next != tx_tail) { tx_buf[tx_head] = c; tx_head = next; }
}
static void tx_text(const char *s) { while (*s != '\0') { tx_push(*s++); } }
static void tx_num(uint32_t value)
{
    char digits[10];
    unsigned n = 0u;
    do { digits[n++] = (char)('0' + (value % 10u)); value /= 10u; } while (value != 0u);
    while (n != 0u) { tx_push(digits[--n]); }
}
static void tx_drain(void)
{
    while ((tx_tail != tx_head) && (UART_FR & 32u) == 0u) {
        UART_DR = (uint8_t)tx_buf[tx_tail];
        tx_tail = (tx_tail + 1u) % TX_SIZE;
    }
}

/* --------------------------------------------------------------------- i2c */

static void i2c_delay(void) { wait_us(I2C_HALF_US); }

static void sda_low(void)  { PB_DIR = PB_DIR_SDA_ON;  SDA = 0u; }
static void sda_free(void) { PB_DIR = PB_DIR_SDA_OFF; }
static uint32_t sda_level(void) { return (SDA >> SDA_POS) & 1u; }

static void i2c_start(void)
{
    sda_free();
    SCL = SCL_BIT; i2c_delay();
    sda_low(); i2c_delay();
    SCL = 0u; i2c_delay();
}

static void i2c_stop(void)
{
    sda_low(); i2c_delay();
    SCL = SCL_BIT; i2c_delay();
    sda_free(); i2c_delay();
}

static void i2c_write_bit(uint32_t bit)
{
    if (bit != 0u) { sda_free(); } else { sda_low(); }
    i2c_delay();
    SCL = SCL_BIT; i2c_delay();
    SCL = 0u; i2c_delay();
}

static uint32_t i2c_read_bit(void)
{
    uint32_t value;
    sda_free();
    i2c_delay();
    SCL = SCL_BIT; i2c_delay();
    value = sda_level();
    SCL = 0u; i2c_delay();
    return value;
}

/* Returns the ACK bit as seen on SDA: 0 = the device acknowledged, 1 = no ack.
 * Reported in the heartbeat so a dead bus is distinguishable from a write that
 * is accepted but not stored (for example a floating WP pin). */
static uint32_t i2c_write_byte(uint8_t value)
{
    unsigned i;
    for (i = 0u; i < 8u; i++) {
        i2c_write_bit((value >> (7u - i)) & 1u);
    }
    return i2c_read_bit();
}

static uint8_t i2c_read_byte(uint32_t ack)
{
    unsigned i;
    uint8_t value = 0u;
    for (i = 0u; i < 8u; i++) {
        value = (uint8_t)((value << 1) | (uint8_t)i2c_read_bit());
    }
    i2c_write_bit(ack != 0u ? 0u : 1u);   /* 0 = master ACK, 1 = master NACK */
    return value;
}

/* ------------------------------------------------------------------ eeprom */

#define EEPROM_WRITE_ADDR 0xA0u
#define EEPROM_READ_ADDR  0xA1u

static uint32_t log_slot;
static volatile uint32_t ack_device = 1u;   /* 0 = EEPROM answered its address */
static volatile uint32_t ack_word = 1u;     /* 0 = EEPROM answered the word address */

static uint32_t eeprom_address_for(uint32_t slot)
{
    return (slot + 1u) * 8u;    /* page 0 left alone; one page per record */
}

static void eeprom_write_page(uint32_t address, const uint8_t *data)
{
    unsigned i;
    i2c_start();
    ack_device = i2c_write_byte(EEPROM_WRITE_ADDR);
    ack_word = i2c_write_byte((uint8_t)(address & 0xFFu));
    for (i = 0u; i < 8u; i++) { (void)i2c_write_byte(data[i]); }
    i2c_stop();
    /* 24C02C needs 10 ms after STOP; the next bus access is one scan step away. */
}

static void eeprom_read_page(uint32_t address, uint8_t *data)
{
    unsigned i;
    i2c_start();
    (void)i2c_write_byte(EEPROM_WRITE_ADDR);
    (void)i2c_write_byte((uint8_t)(address & 0xFFu));
    i2c_start();                       /* repeated start */
    (void)i2c_write_byte(EEPROM_READ_ADDR);
    for (i = 0u; i < 8u; i++) {
        data[i] = i2c_read_byte((i < 7u) ? 1u : 0u);
    }
    i2c_stop();
}

static void log_store(uint32_t angle, uint32_t mm, uint32_t valid, unsigned status)
{
    uint8_t record[8];
    record[0] = (uint8_t)angle;
    record[1] = (uint8_t)(mm & 0xFFu);
    record[2] = (uint8_t)((mm >> 8) & 0xFFu);
    record[3] = (uint8_t)status;
    record[4] = (uint8_t)(valid != 0u ? 1u : 0u);
    record[5] = 0u;
    record[6] = (uint8_t)LOG_MAGIC0;
    record[7] = (uint8_t)LOG_MAGIC1;

    eeprom_write_page(eeprom_address_for(log_slot), record);
    log_slot++;
    if (log_slot >= LOG_SLOTS) { log_slot = 0u; }
}

/* ------------------------------------------------------------------ sensor */

static unsigned measure(uint32_t *width)
{
    uint32_t start;

    *width = 0u;
    TR = 0u;
    wait_us(5u);
    if (ECHO) { return 1u; }

    TR = 4u;
    wait_us(20u);
    TR = 0u;

    start = ticks();
    while (!ECHO) { if (elapsed(start) >= 240000u) { return 2u; } }
    start = ticks();
    while (ECHO) { if (elapsed(start) >= 240000u) { return 3u; } }
    *width = (elapsed(start) + 4u) / TICKS_PER_US;
    /* 2500 mm is the range the dashboard accepts (page limit = 2500 mm);
     * anything longer is reported as NO_HIT instead of silently rejected later. */
    return (*width < 116u || *width > 14500u) ? 4u : 0u;
}

/* ------------------------------------------------------------------- servo */

static void servo_pulse(uint32_t angle)
{
    SERVO = 1u;
    wait_us(1000u + (angle * 1000u) / ANGLE_MAX);
    SERVO = 0u;
}

/* ------------------------------------------------------------------- state */

static uint32_t angle = 90u;
static uint32_t direction = 1u;
static uint32_t running = 1u;
static uint32_t sequence;

/* Scan speed in frames of 20 ms per 3 degree step. The 20 ms servo frame is a
 * hard floor and the serial link sets the real limit: one SCAN line is about
 * 300 bits, so at 9600 baud the link carries ~3 frames per second and a
 * 40 ms step (750 B/s) is the fastest level that still sends whole lines.
 * 10 levels span 40 ms .. 400 ms, i.e. one sweep (61 steps) in 2.4 s .. 24 s. */
static const uint32_t kSpeedSlots[] = { 2u, 3u, 4u, 5u, 6u, 8u, 10u, 12u, 16u, 20u };
#define SPEED_LEVELS (sizeof(kSpeedSlots) / sizeof(kSpeedSlots[0]))
static uint32_t speed_index = 0u;          /* 2 frames = 40 ms per step */

static uint32_t speed_slots(void) { return kSpeedSlots[speed_index]; }
static uint32_t speed_ms(void) { return kSpeedSlots[speed_index] * 20u; }

/* Minimum interval between two SCAN lines, in 8-tick microseconds. */
#define REPORT_MIN_US 80000u
#define REPORT_MIN_TICKS (REPORT_MIN_US * TICKS_PER_US)
static uint32_t last_report;

static void report_speed(void)
{
    tx_text("INFO,SPEED=");
    tx_num(speed_index + 1u);
    tx_text("/");
    tx_num(SPEED_LEVELS);
    tx_text(",STEP_MS=");
    tx_num(speed_ms());
    tx_text(",SWEEP_MS=");
    tx_num(61u * speed_ms());
    tx_text("\r\n");
}

static const char *const status_names[5] = { "OK", "TIMEOUT", "TIMEOUT", "TIMEOUT", "NO_HIT" };

static void advance_angle(void)
{
    if (direction != 0u) {
        angle += ANGLE_STEP;
        if (angle >= ANGLE_MAX) { angle = ANGLE_MAX; direction = 0u; }
    } else {
        angle -= ANGLE_STEP;
        if (angle <= ANGLE_STEP) { angle = 0u; direction = 1u; }
    }
}

static void report_scan(unsigned status, uint32_t mm, uint32_t valid)
{
    tx_text("SCAN,");
    tx_num(sequence++);
    tx_push(',');
    tx_num(angle);
    tx_text(",");
    if (valid != 0u) { tx_num(mm); } else { tx_text("NA"); }
    tx_push(',');
    tx_text(status_names[status]);
    tx_text(",PROTEUS\r\n");
}

/* ------------------------------------------------------------------ replay */

static uint32_t replay_active;
static uint32_t replay_slot;

static void replay_step(void)
{
    uint8_t record[8];

    eeprom_read_page(eeprom_address_for(replay_slot), record);

    if ((record[6] == LOG_MAGIC0) && (record[7] == LOG_MAGIC1)) {
        uint32_t mm = (uint32_t)record[1] | ((uint32_t)record[2] << 8);
        tx_text("LOG,");
        tx_num(replay_slot);
        tx_push(',');
        tx_num(record[0]);
        tx_text(",");
        if (record[4] != 0u) { tx_num(mm); } else { tx_text("NA"); }
        tx_push(',');
        tx_text(status_names[(record[3] < 5u) ? record[3] : 2u]);
        tx_text("\r\n");
    }

    replay_slot++;
    if (replay_slot >= LOG_SLOTS) {
        replay_active = 0u;
        tx_text("INFO,REPLAY_END\r\n");
    }
}

/* ---------------------------------------------------------------- buttons */

static uint32_t last1 = 1u, last3 = 1u;
static uint32_t stable1, stable3;
static uint32_t armed1, armed3;

static uint32_t b1_level(void) { return (BUTTON1 >> B1_BIT) & 1u; }
static uint32_t b2_level(void) { return (BUTTON2 >> B2_BIT) & 1u; }
static uint32_t b3_level(void) { return (BUTTON3 >> B3_BIT) & 1u; }

static void buttons_init(void)
{
    last1 = b1_level();
    last3 = b3_level();
    stable1 = 0u; stable3 = 0u;
    armed1 = (last1 != 0u) ? 1u : 0u;
    armed3 = (last3 != 0u) ? 1u : 0u;
}

static void debounce(uint32_t raw, uint32_t *last, uint32_t *stable, uint32_t *armed, uint32_t *pressed)
{
    if (raw != 0u) { *armed = 1u; }
    if (raw != *last) { *last = raw; *stable = 0u; }
    else if (*stable < 2u) { (*stable)++; }
    if ((*stable == 2u) && (raw == 0u) && (*armed != 0u)) {
        *stable = 3u;                   /* one event per press */
        *pressed = 1u;
    }
}

/* One line per second so a wiring fault is visible even when nothing happens.
 *   BTN,PB1=1,PB5=1,PB4=1    all released (correct resting state)
 *   BTN,PB1=1,PB5=0,...      button 2 held (or that pad stuck low)           */
static void report_buttons(void)
{
    tx_text("BTN,PB1=");
    tx_push((b1_level() != 0u) ? '1' : '0');
    tx_text(",PB5=");
    tx_push((b2_level() != 0u) ? '1' : '0');
    tx_text(",PB4=");
    tx_push((b3_level() != 0u) ? '1' : '0');
    tx_text(",spd=");
    tx_num(speed_index + 1u);
    tx_text(",ack_dev=");
    tx_push((ack_device == 0u) ? '0' : '1');
    tx_text(",ack_word=");
    tx_push((ack_word == 0u) ? '0' : '1');
    tx_text(",slot=");
    tx_num(log_slot);
    tx_text("\r\n");
}

static void poll_buttons(void)
{
    uint32_t pressed1 = 0u, pressed3 = 0u;
    static uint32_t b2_hold = 0u, b2_repeat = 0u;

    debounce(b1_level(), &last1, &stable1, &armed1, &pressed1);
    debounce(b3_level(), &last3, &stable3, &armed3, &pressed3);

    if (pressed1 != 0u) {                   /* start / stop */
        running = (running != 0u) ? 0u : 1u;
        tx_text(running != 0u ? "INFO,RUN\r\n" : "INFO,STOP\r\n");
    }

    /* Speed: one step on the first press, then auto-repeat while held so the
     * control behaves like a continuous dial. */
    if (b2_level() == 0u) {
        b2_hold++;
        if (b2_hold == 3u) {
            speed_index = (speed_index + 1u) % SPEED_LEVELS;
            report_speed();
        } else if (b2_hold > 30u) {         /* 0.6 s after the first action */
            b2_repeat++;
            if (b2_repeat >= 10u) {         /* every 200 ms while held */
                b2_repeat = 0u;
                speed_index = (speed_index + 1u) % SPEED_LEVELS;
                report_speed();
            }
        }
    } else {
        b2_hold = 0u;
        b2_repeat = 0u;
    }

    if (pressed3 != 0u) {                   /* replay the stored log */
        if (replay_active == 0u) {
            replay_active = 1u;
            replay_slot = 0u;
            tx_text("INFO,REPLAY_START\r\n");
        }
    }
}

/* -------------------------------------------------------------------- init */

static void init(void)
{
    SYS_RCC = 0x00002B80u;
    RCGC1 |= 0x10001u;
    RCGC2 |= 0x3u;
    (void)RCGC2; (void)RCGC2; (void)RCGC2;

    PA_DIR = 6u;
#ifdef BUTTONS_ON_PA45
    PA_DEN = 0x3Fu;                     /* PA0..PA5 */
#else
    PA_DEN = 15u;
#endif
    PA_AFSEL = 3u;
    TR = 0u;

    PB_DIR = PB_DIR_SDA_OFF;
#ifdef BUTTONS_ON_PA45
    PB_PUR = 0u;
    PB_DEN = (1u << 0) | (1u << 2) | (1u << 3);
#else
    PB_PUR = (1u << 1) | (1u << 4) | (1u << 5);
    PB_DEN = (1u << 0) | (1u << 1) | (1u << 2) | (1u << 3) | (1u << 4) | (1u << 5);
#endif
    SERVO = 0u;
    SCL = SCL_BIT;
    sda_free();

    UART_CTL = 0u;
    UART_IBRD = 52u;
    UART_FBRD = 5u;
    UART_LCRH = 0x60u;
    UART_CTL = 0x301u;

    T_CTL = 0u;
    T_CFG = 0u;
    T_MODE = 2u;
    T_LOAD = 0xFFFFFFFFu;
    T_CTL = 1u;
}

static void tx_hex2(uint8_t value)
{
    static const char hex[] = "0123456789ABCDEF";
    tx_push(hex[(value >> 4) & 0xFu]);
    tx_push(hex[value & 0xFu]);
}

/* Writes a known pattern to page 0 (which the log ring never uses) and reads it
 * straight back. This separates "the bus is dead" from "the device answers but
 * refuses to store" (a floating WP pin does exactly the latter). */
static void eeprom_selftest(void)
{
    uint8_t out[8];
    uint8_t in[8];
    unsigned i;
    uint32_t ok = 1u;

    for (i = 0u; i < 8u; i++) { out[i] = (uint8_t)(0x11u * (i + 1u)); }
    eeprom_write_page(0u, out);
    wait_us(15000u);
    eeprom_read_page(0u, in);
    for (i = 0u; i < 8u; i++) { if (in[i] != out[i]) { ok = 0u; } }

    if (ok != 0u) {
        tx_text("INFO,EEPROM_SELFTEST_OK\r\n");
    } else {
        tx_text("INFO,EEPROM_SELFTEST_FAIL,wr0=");
        tx_hex2(out[0]);
        tx_text(",rd0=");
        tx_hex2(in[0]);
        tx_text(",wr7=");
        tx_hex2(out[7]);
        tx_text(",rd7=");
        tx_hex2(in[7]);
        tx_text(",ack_dev=");
        tx_push((ack_device == 0u) ? '0' : '1');
        tx_text(",ack_word=");
        tx_push((ack_word == 0u) ? '0' : '1');
        tx_text("\r\n");
        tx_text("HINT,CHECK_WP_PIN_7_TO_GND_AND_A0_A1_A2_TO_GND\r\n");
    }
}

int main(void)
{
    uint32_t slot = 0u;
    uint32_t width;
    uint32_t heartbeat = 0u;
    uint32_t replay_tick = 0u;
    unsigned status;

    init();
    buttons_init();
    wait_us(100000u);

    tx_text("BOOT,LM3S317_RADAR_V13,9600_8N1,SONAR_3V3,EEPROM_24C02C,LOG31\r\n");
    tx_text("INFO,BTN1_RUN_STOP,BTN2_SPEED,BTN3_REPLAY\r\n");
    report_speed();
    eeprom_selftest();

    for (;;) {
        uint32_t frame_start = ticks();
        uint32_t slots = speed_slots();

        servo_pulse(angle);

        if ((slot == 0u) && (running != 0u)) { advance_angle(); }

        poll_buttons();

        if (replay_active != 0u) {
            /* One record every second frame: ~25 characters per 40 ms is well
             * inside the 9600 baud budget. */
            replay_tick++;
            if ((replay_tick & 1u) == 0u) { replay_step(); }
        }

        if ((slot + 1u) == slots) {         /* last frame of this step: measure */
            if (running != 0u) {
                uint32_t mm = 0u, valid = 0u;
                status = measure(&width);
                if (status == 0u) { mm = (width * 10u + 29u) / 58u; valid = 1u; }
                /* Report rate cap: one SCAN line is ~300 bits, so 9600 baud
                 * carries about 3 lines per simulated second. Proteus can run
                 * faster than real time, so cap the reporting interval at 80 ms
                 * of simulated time instead of following the step rate. The
                 * servo keeps stepping; only some steps are reported, which is
                 * what a fast sweep looks like anyway.
                 * While replaying, live frames are suppressed: the replay stream
                 * alone already fills the link. */
                if ((replay_active == 0u) &&
                    ((last_report == 0u) || (elapsed(last_report) >= REPORT_MIN_TICKS))) {
                    last_report = ticks();
                    report_scan(status, mm, valid);
                    log_store(angle, mm, valid, status);
                }
            }
            heartbeat++;
            if (heartbeat >= (1000u / speed_ms())) {
                heartbeat = 0u;
                report_buttons();
            }
        }

        while (elapsed(frame_start) < FRAME_TICKS) { tx_drain(); }
        tx_drain();

        slot = (slot + 1u) % slots;
    }
}

/* ------------------------------------------------- startup and vector table */

extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss, _estack;
static void trap(void) { for (;;) { } }

void Reset_Handler(void);
void Reset_Handler(void)
{
    uint32_t *src = &_sidata;
    uint32_t *dst = &_sdata;
    while (dst < &_edata) { *dst++ = *src++; }
    for (dst = &_sbss; dst < &_ebss; ) { *dst++ = 0u; }
    (void)main();
    trap();
}

__attribute__((section(".isr_vector"), used))
void (*const vectors[64])(void) = {
    (void (*)(void))(&_estack), Reset_Handler, trap, trap, trap, trap, trap,
    0, 0, 0, 0, trap, trap, 0, trap, trap
};

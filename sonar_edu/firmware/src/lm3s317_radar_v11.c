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
 * given model or board revision. */
#ifdef BUTTONS_ON_PA45
#define BUTTON1   PA_DATA(0x10u)   /* PA4, pin 21 */
#define BUTTON2   PA_DATA(0x20u)   /* PA5, pin 22 */
#else
#define BUTTON1   PB_DATA(0x02u)   /* PB1, pin 30 */
#define BUTTON2   PB_DATA(0x20u)   /* PB5, pin 44 */
#endif
#define SCL       PB_DATA(0x04u)   /* PB2 */
#define SDA       PB_DATA(0x08u)   /* PB3 */

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

#define TX_SIZE 192u
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
static uint32_t sda_level(void) { return SDA & 1u; }

static void i2c_start(void)
{
    sda_free();
    SCL = 1u; i2c_delay();
    sda_low(); i2c_delay();
    SCL = 0u; i2c_delay();
}

static void i2c_stop(void)
{
    sda_low(); i2c_delay();
    SCL = 1u; i2c_delay();
    sda_free(); i2c_delay();
}

static void i2c_write_bit(uint32_t bit)
{
    if (bit != 0u) { sda_free(); } else { sda_low(); }
    i2c_delay();
    SCL = 1u; i2c_delay();
    SCL = 0u; i2c_delay();
}

static uint32_t i2c_read_bit(void)
{
    uint32_t value;
    sda_free();
    i2c_delay();
    SCL = 1u; i2c_delay();
    value = sda_level();
    SCL = 0u; i2c_delay();
    return value;
}

static void i2c_write_byte(uint8_t value)
{
    unsigned i;
    for (i = 0u; i < 8u; i++) {
        i2c_write_bit((value >> (7u - i)) & 1u);
    }
    (void)i2c_read_bit();       /* ACK bit: sampled and deliberately ignored */
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

static uint32_t eeprom_address_for(uint32_t slot)
{
    return (slot + 1u) * 8u;    /* page 0 left alone; one page per record */
}

static void eeprom_write_page(uint32_t address, const uint8_t *data)
{
    unsigned i;
    i2c_start();
    i2c_write_byte(EEPROM_WRITE_ADDR);
    i2c_write_byte((uint8_t)(address & 0xFFu));
    for (i = 0u; i < 8u; i++) { i2c_write_byte(data[i]); }
    i2c_stop();
    /* 24C02C needs 10 ms after STOP; the next bus access is one scan step away. */
}

static void eeprom_read_page(uint32_t address, uint8_t *data)
{
    unsigned i;
    i2c_start();
    i2c_write_byte(EEPROM_WRITE_ADDR);
    i2c_write_byte((uint8_t)(address & 0xFFu));
    i2c_start();                       /* repeated start */
    i2c_write_byte(EEPROM_READ_ADDR);
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
    return (*width < 116u || *width > 23200u) ? 4u : 0u;
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

static uint32_t last1 = 1u, last2 = 1u;
static uint32_t stable1, stable2;
static uint32_t armed1, armed2;

static void buttons_init(void)
{
    last1 = ((BUTTON1 & 1u) == 0u) ? 0u : 1u;
    last2 = ((BUTTON2 & 1u) == 0u) ? 0u : 1u;
    stable1 = 0u; stable2 = 0u;
    armed1 = (last1 != 0u) ? 1u : 0u;
    armed2 = (last2 != 0u) ? 1u : 0u;
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

/* One line per second so a wiring fault is visible even when nothing happens:
 *   BTN,PB1=1,PB5=1   both released (correct resting state)
 *   BTN,PB1=0,PB5=1   button 1 held (or PB1 stuck low / pull-up missing)     */
static void report_buttons(void)
{
    tx_text("BTN,PB1=");
    tx_push(((BUTTON1 & 1u) != 0u) ? '1' : '0');
    tx_text(",PB5=");
    tx_push(((BUTTON2 & 1u) != 0u) ? '1' : '0');
    tx_text("\r\n");
}

static void poll_buttons(void)
{
    uint32_t pressed1 = 0u, pressed2 = 0u;

    debounce(((BUTTON1 & 1u) == 0u) ? 0u : 1u, &last1, &stable1, &armed1, &pressed1);
    debounce(((BUTTON2 & 1u) == 0u) ? 0u : 1u, &last2, &stable2, &armed2, &pressed2);

    if (pressed1 != 0u) {
        running = (running != 0u) ? 0u : 1u;
        tx_text(running != 0u ? "INFO,RUN\r\n" : "INFO,STOP\r\n");
    }
    if (pressed2 != 0u) {
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
    PB_PUR = (1u << 1) | (1u << 5);
    PB_DEN = (1u << 0) | (1u << 1) | (1u << 2) | (1u << 3) | (1u << 5);
#endif
    SERVO = 0u;
    SCL = 1u;
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

int main(void)
{
    uint32_t slot = 0u;
    uint32_t width;
    uint32_t heartbeat = 0u;
    unsigned status;

    init();
    buttons_init();
    wait_us(100000u);

    tx_text("BOOT,LM3S317_RADAR_V11,9600_8N1,SONAR_3V3,EEPROM_24C02C,LOG31\r\n");
    tx_text("INFO,BTN1_RUN_STOP,BTN2_REPLAY\r\n");

    for (;;) {
        uint32_t frame_start = ticks();

        servo_pulse(angle);

        if (slot == 0u) {
            if (running != 0u) { advance_angle(); }
        } else if (slot == 3u) {
            if (running != 0u) {
                uint32_t mm = 0u, valid = 0u;
                status = measure(&width);
                if (status == 0u) { mm = (width * 10u + 29u) / 58u; valid = 1u; }
                report_scan(status, mm, valid);
                log_store(angle, mm, valid, status);
            }
        } else if (slot == 1u) {
            poll_buttons();
        } else if (slot == 2u) {
            if (replay_active != 0u) { replay_step(); }
            heartbeat++;
            if (heartbeat >= 13u) { heartbeat = 0u; report_buttons(); }
        }

        while (elapsed(frame_start) < FRAME_TICKS) { tx_drain(); }
        tx_drain();

        slot = (slot + 1u) % SLOTS_PER_STEP;
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

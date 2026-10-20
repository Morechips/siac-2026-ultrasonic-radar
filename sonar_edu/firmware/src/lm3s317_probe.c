#include <stdint.h>

/* Original minimal Cortex-M3 diagnostic. LM3S317, crystal/system clock 8 MHz.
 * PA1 UART0 TX 9600 8N1; PA2 TR; PA3 ECHO. No fabricated distance data. */
#define R(a) (*(volatile uint32_t *)(a))
#define SYS_RCC R(0x400fe060u)
#define RCGC1 R(0x400fe104u)
#define RCGC2 R(0x400fe108u)
#define PA_DATA R(0x400043fcu)
#define PA_DIR R(0x40004400u)
#define PA_AFSEL R(0x40004420u)
#define PA_DEN R(0x4000451cu)
#define TR R(0x40004010u) /* Masked GPIO data: mask 0x04. */
#define ECHO R(0x40004020u)
#define UART_DR R(0x4000c000u)
#define UART_FR R(0x4000c018u)
#define UART_IBRD R(0x4000c024u)
#define UART_FBRD R(0x4000c028u)
#define UART_LCRH R(0x4000c02cu)
#define UART_CTL R(0x4000c030u)
#define T_CFG R(0x40030000u)
#define T_MODE R(0x40030004u)
#define T_CTL R(0x4003000cu)
#define T_LOAD R(0x40030028u)
#define T_COUNT R(0x40030048u)

static void put(char c) { while ((UART_FR & 32u) != 0u) {} UART_DR=(uint8_t)c; }
static void text(const char *s) { while (*s) put(*s++); }
static void number(uint32_t v) {
    char a[10]; unsigned n=0;
    do { a[n++]=(char)('0'+v%10u); v/=10u; } while(v);
    while(n) put(a[--n]);
}
static uint32_t ticks(void) { return ~T_COUNT; }
static uint32_t elapsed(uint32_t t) { return ticks()-t; }
static void wait_us(uint32_t us) { uint32_t t=ticks(); while(elapsed(t)<us*8u) {} }
static void init(void) {
    SYS_RCC=0x00002b80u; /* main oscillator, 8MHz crystal, bypass/power down PLL */
    RCGC1|=0x10001u; RCGC2|=1u;
    (void)RCGC2; (void)RCGC2; (void)RCGC2;
    PA_AFSEL=3u; PA_DIR=6u; PA_DEN=15u; TR=0u;
    UART_CTL=0u; UART_IBRD=52u; UART_FBRD=5u;
    UART_LCRH=0x60u; UART_CTL=0x301u;
    T_CTL=0u; T_CFG=0u; T_MODE=2u; T_LOAD=0xffffffffu; T_CTL=1u;
}
static unsigned measure(uint32_t *width) {
    uint32_t t;
    *width=0u; TR=0u; wait_us(5u);
    if(ECHO) return 1u;
    TR=4u; wait_us(20u); TR=0u;
    t=ticks(); while(!ECHO) if(elapsed(t)>=240000u) return 2u;
    t=ticks(); while(ECHO) if(elapsed(t)>=240000u) return 3u;
    *width=(elapsed(t)+4u)/8u;
    return (*width<116u || *width>23200u)?4u:0u;
}
int main(void) {
    static const char *const names[]={"OK","ECHO_BUSY","NO_RISE","NO_FALL","RANGE_ERROR"};
    uint32_t seq=0u,width; unsigned s;
    init(); text("BOOT,LM3S317,8MHZ,PA2_TR,PA3_ECHO\r\n"); wait_us(100000u);
    for(;;) {
        s=measure(&width);
        text("SONAR,S="); number(seq++); text(",STATUS="); text(names[s]);
        text(",ECHO_US="); if(s==0u||s==4u) number(width); else text("NA");
        text(",D_MM="); if(s==0u) number((width*10u+29u)/58u); else text("NA");
        text("\r\n"); wait_us(100000u);
    }
}

extern uint32_t _sidata,_sdata,_edata,_sbss,_ebss,_estack;
static void trap(void) { for(;;) {} }
void Reset_Handler(void) {
    uint32_t *s=&_sidata,*d=&_sdata;
    while(d<&_edata) *d++=*s++;
    for(d=&_sbss;d<&_ebss;) *d++=0u;
    (void)main(); trap();
}
__attribute__((section(".isr_vector"),used))
void (*const vectors[64])(void)={
    (void (*)(void))(&_estack),Reset_Handler,trap,trap,trap,trap,trap,
    0,0,0,0,trap,trap,0,trap,trap
};

# LM3S317 雷达 V10：超声 + 舵机 + 串口（无 OLED）

日期：2026-10-20 夜。固件：[lm3s317_radar_v10.hex](../../../stm32_build/lm3s317_radar_v10.hex)（1628 字节，SP=0x20001000，Reset=0x00000519，text 1604 / data 24 / bss 148，HEX 校验通过）。

## 为什么换成这个

OLED 是这套系统里唯一"会把整机锁死"的部件（两天里多次 NACK 后 HOLD，换了 6 版固件都没根治）。本版把它整块删掉，只保留四件**在这台机器上各自实测通过**的东西：

| 功能 | 来源 | 已验证的事实 |
|---|---|---|
| 超声测距 | `lm3s317_probe.c` 原样搬用 | 50cm→500mm/2901µs，51cm→510mm/2959µs |
| 舵机 PWM | 与 V04 相同的 PB0 软件 PWM | 集成版实际转动、往返 |
| 串口 | 与 V04 相同的 PA1/9600 8N1 | V04 连跑约 50s，TX_DROPS=0 |
| 按键输入 | INPUT_V2 验证过的 GPIO 输入方式 | 随数字源正确读值 |

视觉雷达图改由网页承担（`sonar_edu/showcase`）。

## 接线

> **供电结论（2026-10-21 实测）**：本机 HCSR04/SRF04 模型必须接 **3.3V**。接 5V 时触发脚读数正常但 ECHO 全程不动——这就是此前 F103 与 LM3S317 两条线"触发正常、无回波"的共同原因。实物 HC-SR04 需要 5V，**仿真与实物在此不同**，说明书须写明；仿真接 3.3V 同时避免了 5V ECHO 直连非 5V 容忍引脚的问题。

| 信号 | LM3S317 | 物理脚 | 外设 |
|---|---|---|---|
| UART TX | PA1 | 18 | Virtual Terminal RXD（之后换 COMPIM） |
| 触发 | PA2 | 19 | SRF04 TR（3 脚） |
| 回波 | PA3 | 20 | SRF04 ECHO（2 脚） |
| 模块电源 | — | — | **VCC → 3.3V（默认电源网 VCC/VDD），GND 共地** |
| 舵机 | PB0 | 29 | MOTOR-PWMSERVO CTRL |
| 按键1 | PB1 | 30 | 按钮到 GND，启动/停止（可选，暂不接也能跑） |
| 按键2 | PB5 | 32 | 按钮到 GND，扫描/定点切换（可选） |

PB2/PB3/PB4 本版完全不用；OLED 留在图上也不影响（固件不碰它）。后续要接 AT24C02 EEPROM 时复用 PB2/PB3。

## 运行

1. 打开 `proteus/current_test/LM3S317_radar_servo_v04_labels.pdsprj`
2. **另存为** `LM3S317_radar_v10.pdsprj`（不要覆盖 V04 基线）
3. 双击 MCU，Program File 改成：
   `D:\仿真创新大赛\stm32_build\lm3s317_radar_v10.hex`
4. Virtual Terminal 设 9600 / 8 / 无校验 / 1 停止，PA1→RXD
5. 运行

## 应看到什么

```text
BOOT,LM3S317_RADAR_V10,9600_8N1,SCAN_STEP=3DEG,STEP_MS=80
INFO,NO_OLED,SONAR_PA2_PA3,SERVO_PB0,BUTTONS_PB1_PB5
SCAN,0,93,500,OK,PROTEUS
SCAN,1,96,500,OK,PROTEUS
...
SCAN,30,180,NA,TIMEOUT,PROTEUS
SCAN,31,177,500,OK,PROTEUS
```

- **角度**每 80ms 前进 3°，从 90° 递增到 180°，再回到 0°，往返循环（单程约 2.4 秒）
- **距离**：有效时基本恒为 500mm 左右 —— **这是模型特性，不是 bug**。HCSR04 模型的距离来自属性里的固定 `SETPOINT=50cm`，不会随舵机转动而变化。它验证的是"采集与上报链路"，不是"空间建图"
- **状态**：`OK` 有回波；`TIMEOUT` 没回波（`NO_RISE`/`NO_FALL`/`ECHO_BUSY`）；`NO_HIT` 超量程
- **舵机**应该肉眼可见地来回扫描

## 验收标准

1. 出现 BOOT 行
2. `SCAN` 行连续不断，角度按 3° 递增/递减
3. 大多数行是 `OK` 且距离约 500（若全 `TIMEOUT`，说明这个电路里的测距又退化了）
4. 舵机实际来回转动

## 下一步（通过之后）

1. 接两个按钮（PB1/PB5 → GND），验证 INFO,RUN / INFO,STOP / MODE 切换
2. 接 AT24C02 EEPROM 到 PB2/PB3，做扫描记录存储与回放（占"存储"+"I2C 协议"两条要求）
3. 把 Virtual Terminal 换成 COMPIM，接虚拟串口对，网页读数据

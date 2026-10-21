# 基于 Cortex-M3 的超声旋转扫描雷达（Proteus 仿真）

2026 年仿真创新大赛 · 本科组 · Proteus 方向参赛作品。

一个完整的闭环系统：**舵机带动超声探头旋转扫描 → MCU 测距与调度 → 串口上报 → 网页实时可视化**。

主控为 **TI LM3S317（Cortex-M3，8 MHz）**，全部功能在 Proteus 8.9 中仿真运行，PC 端网页承担人机交互显示界面。

---

## 系统组成

```
                   ┌──────────────┐
     SRF04 超声 ──►│              │
        ▲          │   LM3S317    │──► UART0 (PA1, 9600 8N1)
        │ 20µs 触发 │   Cortex-M3  │         │
        └──────────│              │         ▼
     PB0 舵机 PWM  │              │    COMPIM ──► 虚拟串口对 ──► 网页雷达
                   └──────┬───────┘
                          │ I2C (PB2/PB3)
                          ▼
                    24C02C EEPROM（扫描记录存储）
```

| 模块 | 实现 | 引脚 |
|---|---|---|
| 数据采集 | SRF04 超声测距（20 µs 触发，回波脉宽计时） | TR=PA2, ECHO=PA3 |
| 控制 | 舵机 50 Hz 软件 PWM，0~180° 每步 3° | PB0 |
| 存储 | 24C02C I2C EEPROM，31 条记录滚动存储 + 按键回放 | PB2=SCL, PB3=SDA |
| 人机交互 | 按键（启动/停止、回放） | PB1 / PB5 |
| 输出 | 六字段 ASCII 帧 | PA1 (UART0 TX) |
| 显示 | 网页雷达（Three.js + Canvas 2D） | PC 侧 |

**当前状态（2026-10-21）**：上述全部模块均已在本机 Proteus 中实测通过，包括按键、EEPROM 写入与 31 条记录回放。

### 串口协议

```
SCAN,<序号>,<角度0~180>,<距离mm | NA>,<OK | TIMEOUT | NO_HIT>,PROTEUS
LOG,<槽位>,<角度>,<距离mm | NA>,<OK | TIMEOUT | NO_HIT>     ← 存储回放
INFO,...                                                        ← 诊断信息
```

示例：

```
SCAN,0,93,1120,OK,PROTEUS
LOG,0,93,1120,OK
INFO,EEPROM_SELFTEST_OK
```

---

## 目录结构

```
sonar_edu/
  firmware/
    src/lm3s317_radar_v12.c   主固件：扫描调度、测距、EEPROM、按键、串口
    src/lm3s317_probe.c       最小测距验证固件（主固件测距序列的来源）
    lm3s317.ld                链接脚本（16K Flash / 4K RAM）
    build-lm3s317.ps1         构建脚本（ARM GCC）
  proteus/current_test/
    LM3S317_radar_v12_working.pdsprj   已验证的仿真工程
  showcase/                   网页雷达（TypeScript + Vite + Three.js）
  cairn/LOG.md                开发日志与验证记录
stm32_build/
  lm3s317_radar_v12.hex       构建好的固件
```

> Proteus 工程内的 Program File 使用相对路径 `..\..\..\stm32_build\lm3s317_radar_v12.hex`，
> 仓库保持相同层级，因此**打开即可直接运行，无需改路径**。

---

## 复现步骤

### 1. 打开仿真

用 Proteus 8.9 打开 `sonar_edu/proteus/current_test/LM3S317_radar_v11_working.pdsprj`，直接运行。

Virtual Terminal（PA1）应输出：

```
BOOT,LM3S317_RADAR_V11,9600_8N1,SONAR_3V3,EEPROM_24C02C,LOG31
SCAN,0,93,710,OK,PROTEUS
...
```

### 2. 建立虚拟串口对

安装 [com0com](https://sourceforge.net/projects/com0com/)（64 位系统装 x64 版）。安装后自动生成两对端口，取其中一对，例如 `COM32 ↔ COM33`：

- Proteus 的 **COMPIM** 用 COM32
- 网页用 COM33

### 3. 网页

```bash
cd sonar_edu/showcase
npm install
npm run dev          # 或双击 start.cmd
```

用 **Chrome / Edge** 打开 `http://localhost:5173/` → 右上角「连接与数据」→「浏览器串口」→ 波特率 9600 → 选 COM33 → 连接。

### 4. 重新构建固件（可选）

```powershell
cd sonar_edu/firmware
.\build-lm3s317.ps1 -SourceCode src\lm3s317_radar_v11.c -Stem lm3s317_radar_v11r1
```

需要 ARM GCC（STM32CubeCLT 或 arm-none-eabi 工具链），脚本内路径按本机环境修改。

---

## 踩过的坑（复现时最容易卡住的地方）

| 现象 | 原因 | 解决 |
|---|---|---|
| 触发正常但始终没有回波 | **该超声模型必须 3.3 V 供电**，接 5 V 时不响应触发 | 模块 VCC 接 3.3 V（实物 HC-SR04 需 5 V，需电平适配） |
| 按键永远读 0、I2C 一个时钟都不出 | **GPIO 掩码访问误用**：掩码读回的位仍在原位（要右移），掩码写入只有掩码对应位有效（要写掩码值而不是 1） | `(reg >> pin) & 1` 读；写时用 `0x04` 这类掩码值 |
| EEPROM 应答但读回全 `00` | **SDA 缺上拉**（空片应读 `FF`） | SDA 加 10 k 上拉到 3.3 V |
| EEPROM 应答但写不进去 | WP（7 脚）未接地 | WP 接 GND |
| COMPIM 打开了端口但收不到数据 | **COMPIM 引脚按 MCU 侧命名**，MCU TX 要接 **TXD** 而不是 RXD | PA1 → COMPIM TXD |
| 同上 | COMPIM 默认开启硬件流控，CTS 悬空时数据被扣住 | 属性里 `P_HARDFLOW=0`、`V_HARDFLOW=0` |
| 端口下拉框只有 COM1~COM4 | COMPIM 只枚举部分端口 | 直接手打 `COM32` 有效 |
| 网页连上但画面不动 | 仿真处于**暂停**状态 | 确认 Proteus 在运行 |
| Proteus 报 `[SPICE] {null}` | 悬空的模拟仪表（如未接线的电压表） | 删除该仪表，或先接好两个端子再运行 |

---

## 已知限制（如实说明）

1. **距离恒定为设定值**：Proteus 的 SRF04 模型距离由元件属性 `SETPOINT` 固定给出，不随角度变化，因此扫描结果是等距圆弧。本作品验证的是**采集—处理—传输—显示**链路，不是空间建图。演示时可在运行中点击模块的上下箭头改变距离，验证系统跟随。
2. **仿真供电与实物不同**：仿真中模块接 3.3 V（见上表）；实物 HC-SR04 需 5 V，且其 5 V ECHO 输出不能直连非 5 V 容忍引脚，需分压或电平转换。
3. **存储容量**：24C02C 仅 256 字节，日志环为 31 条（约半圈扫描），用于证明存储与回放链路，不作为长时间记录。
4. **量程**：固件与网页统一为 2500 mm，超出按 `NO_HIT` 处理。

---

## 环境

- Proteus 8.9 SP2
- ARM GCC（`arm-none-eabi`，STM32CubeCLT 1.21.0 内）
- Node.js + pnpm/npm（网页）
- com0com 3.0.0.0（虚拟串口对，官方签名版）
- 浏览器：Chrome / Edge（Web Serial 仅 Chromium 内核支持）

# OLED显示接线与测试（Proteus 8.9）

日期：2026年10月14日。2026年10月16日更新：V05已实测出图，使用原3.3V配置及实际3D地址。下文保留初始接线方法；复现请优先看[黑屏定位与通过工程](OLED黑屏定位与已通过工程_2026-10-16.md)，不要再用旧ACK有误报的V01固件验收。

## 1. 使用预接线片段

截图中的UG-2864HSWEG01为128×64、SSD1306屏幕，本机8.9自带模型。蓝色D[0..7]及BS[0..2]是总线，不能把整个总线用一根普通导线接到GPIO。先复用本机原厂片段，省去手动拆分总线。

1. 停止仿真，用“文件 → 另存为”保存副本`stm32f103_oled_test.pdsprj`，保留超声工程。
2. 删除刚放上去但未接线的屏幕。
3. 在“文件”菜单选择“导入工程片段 / Import Project Clip”（中文翻译可能不同）。本机ISIS.DLL已确认有此命令；不是“导入元件库”。
4. 文件名栏粘贴下面的完整路径，选中并放置整组片段：

   ```text
   D:\仿真创新大赛\sonar_edu\proteus\clips\OLED_I2C_本机原厂片段.pdsclip
   ```

保留片段内部连线和AD4、AD5、IO4端子名称。Arduino字样来自原模板的端子命名，本次仍由F103驱动屏幕。

原文件位于：

```text
D:\Proteus 8\Proteus 8 Professional\DATA\Snippets\Arduino\Arduino SSD1306 128x64 Graphics Display I2C Breakout Board.pdsclip
```

## 2. 接三根信号线和两只上拉电阻

| 片段端子 | 功能 | F103引脚 | 当前符号脚号 |
|---|---|---|---|
| AD5 | SCL时钟 | PB6 | 42 |
| AD4 | SDA数据 | PB7 | 43 |
| IO4 | 屏幕复位 | PB5 | 41 |

从GPIO端点拉普通导线到对应片段端子的连接点。再放两只`RES`，均为`4.7k`：一只接SCL与现有`VDD3.3`之间，另一只接SDA与`VDD3.3`之间。

2026-10-15接线复核：用户图中的端子对应正确，但R3、R4串在信号通路中。应先用导线直接接通PB6—AD5、PB7—AD4，再从各信号线上分支，经4.7k接3.3V。具体核对结果与原始资料见[接线核对与基础资料导读](接线核对与基础资料导读_2026-10-15.md)。

F103仍保持3.3V供电、NRST上拉和BOOT0接地。PA9（30脚）仍接虚拟终端RXD；终端9600、8位、无校验、1停止位。

本轮先保持PA1（11脚）所有外部导线断开，便于屏幕与GPIO对照；PB0的LED可以保留。本测试不会发送正常的15us超声触发。

## 3. 仿真片段与实物电源的区别

原厂片段简化了裸屏电源外围；未命名POWER端子使用工程默认VCC电网。本项目最近备份中默认VCC为3.3V，先沿用此配置验证模型，不为OLED把F103的VDD改成5V。该供电组合仍待仿真运行确认。

实物裸屏中VDD是逻辑供电，VCC是显示驱动供电，外供模式的VCC典型9V；两者不能因名字接近而短接。本片段用于验证仿真显示功能，不能直接作为实物裸屏供电设计。实物宜选带外围电路的四针I2C成品模块，按所购模块允许的输入电压接线。[厂家规格书](https://www.adafruit.com/datasheets/UG-2864HSWEG01.pdf)

## 4. 加载固件

编辑U1属性，在Program File选择：

```text
D:\仿真创新大赛\sonar_edu\firmware\build\oled_gpio_diag.hex
```

Crystal Frequency保持`8MHz`；本固件实际使用内部HSI 8MHz，无需外加晶振。确定后重新开始仿真。

屏幕正常预期：

```text
OLED READY

GPIO TEST

CMD: LOW
PA1: LOW

ECHO: LOW
```

CMD和PA1在HIGH/LOW间交替，每个输出保持约0.75秒，加上屏幕写入时间。PA1是程序读取GPIO输入寄存器的结果，并非屏幕自行测量电压；ECHO显示PA0当前电平，不能当作距离。

先确认PA1隔离时CMD与PA1一致，再移除示波器、单独接回PA1→模块TR作对照。这仍是慢速输出诊断，测距需要再加载正常测距固件。

## 5. 黑屏时用串口定位

启动行必须为`BOOT,OLED_GPIO_V01,HSI=8000000,BAUD=9600`。应答成功后预期：

```text
OLED,ACK=1,ADDR=3C
O,cmd=0,pa1=0,pa0=0,screen_write=1,bus_error=0
O,cmd=1,pa1=1,pa0=0,screen_write=1,bus_error=0
```

固件也探测3D地址。失败时继续输出，不在I2C等待中永久卡住。

| 字段 | 意义与优先检查 |
|---|---|
| ACK_OR_INIT_FAILED | 地址无应答或初始化失败；查AD4/AD5、复位、模式与供电 |
| bus_error=1 | SCL释放250us后仍低；查PB6、4.7k上拉和外部网络 |
| bus_error=2 | 开始传输前SDA不是高；查PB7、上拉和外部网络 |
| bus_error=3 | 未收到ACK；查屏幕模式、数据线和复位 |
| screen_write=1 | 本帧命令与像素传输均获应答；黑屏仍需查显示供电与模型 |

ACK或screen_write=1不能单独证明可读文字已经出现。验收需要屏幕截图和连续高低切换。

## 6. 内部接法依据与验证范围

I2C模式为BS0=0、BS1=1、BS2=0。D0为SCL；D1/D2承担SDA输入/输出，物理裸屏的I2C接法应连接D1和D2。D/C#接地选3C地址，CS#接地，RES#用于复位。[SSD1306控制器资料](https://cdn-shop.adafruit.com/datasheets/SSD1306.pdf)

初始化命令参考本机Arduino I2C示例；软件I2C、精简字模与1024字节帧缓冲由本项目独立实现。示例中的Arduino程序不能直接加载F103。

源码：`firmware/src/oled_diagnostic.c`；构建：`firmware/build-oled-diagnostic.ps1`。现有HEX可直接加载，无需再建Keil工程。

已完成：ARMCC5无警告编译/链接，HEX校验和、Flash范围及启动向量检查，无BKPT 0xAB半主机断点。最初ROM2332字节，共用函数整理后当前ROM2344字节；静态RAM1124字节，另预留2KB栈，容量符合F103C6。

待执行：片段导入、接线、I2C应答、实际文字显示及HIGH/LOW交替。屏幕通过后再加入真实有效距离、无回波状态；扫描通过后再加入角度、扫线和点迹。测距未通过时不显示编造的距离或地图。

2026-10-15进展：片段已导入、上拉已改为分支；用户截图有3C及帧事务应答，cmd/pa1一致切换，但仍无文字。按[OLED分步诊断](OLED有应答但无像素_分步诊断.md)继续；上段待办以此最新进展更新。

# OLED显示准备

日期：2026年10月14日。用户希望用OLED一类屏幕展示程序结果。

已只读确认本机Proteus8.9的DATA/LIBRARY/DISPLAY.LIB包含SSD1306控制器及UG-2864HSWEG01屏幕模型。屏幕为128×64点阵，内部模型文件为UG2864HSWEG01，使用LCDPIXEL.DLL；不需要为这个型号先安装第三方库。控制器SSD1306符号本身与带显示区域的屏幕符号不同。

在P元件选择器搜索UG-2864HSWEG01，选择带显示区域的屏幕。该符号为多引脚模块，需要按I2C接口配置BS引脚、控制引脚和数据引脚；不能直接按常见四针模块的管脚名称接线。先提供放置后可读的引脚图，再按该型号完成接线与固件。

本机配套示例在：

```text
D:\Proteus 8\Proteus 8 Professional\DATA\SAMPLES\VSM for AVR\Arduino SSD1306 Breakboard Display\Arduino SSD1306 Breakboard Display 128x64 I2C.pdsprj
```

示例可作为屏幕接口接法与初始化命令依据，不能直接当作F103固件加载。本机示例中的Arduino程序文件使用作者机器临时路径，若直接运行可能需要重新编译或重新选择程序；当前未修改或运行该示例。

先单独验证固定文字显示，再显示GPIO命令和读回：

```text
GPIO TEST
CMD: LOW
PA1: LOW
```

如果输出命令低而读回高，显示CMD: LOW及PA1: HIGH。后续测距通过后，再加入距离、角度、有效/无回波状态和扫点图。

屏幕由F103发送显示内容，它本身不自动读取PA1或测量距离。串口可保留记录，屏幕承担直观显示。OLED只改变展示方式，不证明超声触发与回波故障已解决。

当前状态：用户已放置屏幕；已准备原厂预接线片段、PB5/6/7接线说明和oled_gpio_diag.hex。编译及启动静态检查通过；实际I2C应答与显示待验证。按[OLED显示接线与测试](D:/仿真创新大赛/sonar_edu/docs/OLED显示接线与测试.md)继续。

官方型号支持依据：[Labcenter外设模型列表](https://www.labcenter.com/peripherals/)。本机文件内容是当前8.9环境是否具备该型号的直接依据。

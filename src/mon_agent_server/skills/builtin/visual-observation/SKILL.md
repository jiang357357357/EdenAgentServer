---
name: visual-observation
description: 分析附件、本地图片，观察当前桌面屏幕，或拍摄摄像头单帧了解现实环境。
metadata:
  monagent:
    display_name: 图片、屏幕与摄像头观察
    version: 1.0.0
    tools: [analyze_image, analyze_screen, capture_camera]
    profiles: [user_chat, self_awake]
---

- 分析附件或本地图片路径时使用 analyze_image；想了解用户正在做什么、确认桌面状态或完成当前意图时，可主动使用 analyze_screen；需要了解现实环境时，可主动使用 capture_camera 拍摄单帧。
- 多模态模型已经直接收到的附件图片无需重复分析；file:// 或绝对路径图片仍使用 analyze_image。
- 根据自己的判断选择是否观察以及观察哪一种来源；一次调用只采集当前一帧，需要继续观察时再作决定。

"""
终端 SVG 渲染引擎

使用 SVG 精确渲染终端文本，保持与终端完全一致的显示效果
"""

import re
import unicodedata
from html import escape


def get_char_width(char):
    """获取字符宽度（按终端标准）
    
    Args:
        char: 单个字符
        
    Returns:
        1: 半角字符
        2: 全角字符（中文、日文等）
    """
    if unicodedata.east_asian_width(char) in ('F', 'W'):
        return 2
    return 1


def parse_ansi_text(text):
    """解析 ANSI 文本，返回字符列表和样式信息
    
    Returns:
        List of (char, color, bold) tuples
    """
    result = []
    current_color = '#d4d4d4'  # 默认颜色
    current_bold = False
    
    # ANSI 颜色映射
    ansi_colors = {
        '30': '#000000', '31': '#cd3131', '32': '#0dbc79', '33': '#e5e510',
        '34': '#2472c8', '35': '#bc3fbc', '36': '#11a8cd', '37': '#e5e5e5',
        '90': '#666666', '91': '#f14c4c', '92': '#23d18b', '93': '#f5f543',
        '94': '#3b8eea', '95': '#d670d6', '96': '#29b8db', '97': '#ffffff',
    }
    
    # 分割 ANSI 码和文本
    pattern = r'\x1b\[([\d;]+)m'
    last_end = 0
    
    for match in re.finditer(pattern, text):
        # 添加之前的文本
        if match.start() > last_end:
            plain_text = text[last_end:match.start()]
            for char in plain_text:
                result.append((char, current_color, current_bold))
        
        # 处理 ANSI 码
        codes = match.group(1).split(';')
        for code in codes:
            if code == '0' or code == '':
                current_color = '#d4d4d4'
                current_bold = False
            elif code == '1':
                current_bold = True
            elif code in ansi_colors:
                current_color = ansi_colors[code]
        
        last_end = match.end()
    
    # 添加剩余文本
    if last_end < len(text):
        plain_text = text[last_end:]
        for char in plain_text:
            result.append((char, current_color, current_bold))
    
    return result


def create_terminal_svg(ansi_text, width, title=None, panel_type=None, stage=None, timestamp=None):
    """创建 SVG，精确渲染终端文本
    
    Args:
        ansi_text: 带 ANSI 颜色码的文本
        width: 终端宽度（字符数）
        title: 面板标题
        panel_type: 面板类型
        stage: 执行阶段
        timestamp: 时间戳
        
    Returns:
        SVG 字符串
    """
    lines = ansi_text.split('\n')
    
    # 解析每一行
    parsed_lines = []
    max_line_width = 0  # 记录最大行宽
    for line in lines:
        chars = parse_ansi_text(line)
        parsed_lines.append(chars)
        
        # 计算这一行的实际宽度（考虑全角字符）
        line_width = sum(get_char_width(char) for char, _, _ in chars)
        max_line_width = max(max_line_width, line_width)
    
    # 计算 SVG 尺寸 - 使用实际内容宽度而不是终端宽度
    char_width = 8.4
    char_height = 18
    padding_top = 80  # 增加顶部空间用于显示元数据
    padding_horizontal = 40  # 左右边距
    svg_width = int(max_line_width * char_width) + padding_horizontal
    svg_height = len(lines) * char_height + padding_top + 20
    
    # 开始构建 SVG
    svg_parts = []
    svg_parts.append(f'<?xml version="1.0" encoding="UTF-8"?>')
    svg_parts.append(f'<svg width="{svg_width}" height="{svg_height}" xmlns="http://www.w3.org/2000/svg">')
    
    # 背景（透明）
    svg_parts.append(f'  <rect width="100%" height="100%" fill="transparent"/>')
    
    # 定义字体样式
    svg_parts.append('  <style>')
    svg_parts.append('    text { font-family: "Noto Serif CJK SC", "Noto Color Emoji", monospace; font-size: 14px; letter-spacing: -0.05em; }')
    svg_parts.append('    text.bold { font-weight: bold; }')
    svg_parts.append('    text.meta { font-family: "Noto Serif CJK SC", "Noto Color Emoji", sans-serif; font-size: 12px; fill: #858585; letter-spacing: normal; }')
    svg_parts.append('    text.meta-value { fill: #4ec9b0; }')
    svg_parts.append('  </style>')
    
    # 添加元数据信息
    meta_y = 20
    if panel_type:
        svg_parts.append(f'  <text x="20" y="{meta_y}" class="meta">面板类型: <tspan class="meta-value">{escape(panel_type)}</tspan></text>')
        meta_y += 16
    if stage:
        svg_parts.append(f'  <text x="20" y="{meta_y}" class="meta">执行阶段: <tspan class="meta-value">{escape(stage)}</tspan></text>')
        meta_y += 16
    if timestamp:
        svg_parts.append(f'  <text x="20" y="{meta_y}" class="meta">时间戳: <tspan class="meta-value">{escape(timestamp)}</tspan></text>')
        meta_y += 16
    if title:
        svg_parts.append(f'  <text x="20" y="{meta_y}" class="meta">标题: <tspan class="meta-value">{escape(title)}</tspan></text>')
        meta_y += 16
    
    # 分隔线
    svg_parts.append(f'  <line x1="20" y1="{meta_y + 5}" x2="{svg_width - 20}" y2="{meta_y + 5}" stroke="#3e3e42" stroke-width="1"/>')
    
    # 表格线字符集合 - 包含所有 Rich 支持的边框字符
    box_chars = set([
        # 基本边框 (SQUARE, ROUNDED)
        '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼',
        # 粗边框 (HEAVY)
        '━', '┃', '┏', '┓', '┗', '┛', '┣', '┫', '┳', '┻', '╋',
        # 双边框 (DOUBLE)
        '═', '║', '╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩', '╬',
        # 圆角边框
        '╭', '╮', '╰', '╯',
    ])
    
    # 收集线段（精确绘制，不超出字符边界）
    h_lines = {}  # y -> [(x1, x2, color)]
    v_lines = {}  # x -> [(y1, y2, color)]
    corner_chars = []  # 收集圆角字符 [(char, x, y, color)]
    
    # 定义字符的连接方向（上下左右）
    # True 表示该方向有连接
    char_connections = {
        # 基本边框
        '─': (False, False, True, True),   # 左右
        '│': (True, True, False, False),   # 上下
        '┌': (False, True, False, True),   # 下右
        '┐': (False, True, True, False),   # 下左
        '└': (True, False, False, True),   # 上右
        '┘': (True, False, True, False),   # 上左
        '├': (True, True, False, True),    # 上下右
        '┤': (True, True, True, False),    # 上下左
        '┬': (False, True, True, True),    # 下左右
        '┴': (True, False, True, True),    # 上左右
        '┼': (True, True, True, True),     # 上下左右
        # 粗边框 (HEAVY)
        '━': (False, False, True, True),
        '┃': (True, True, False, False),
        '┏': (False, True, False, True),
        '┓': (False, True, True, False),
        '┗': (True, False, False, True),
        '┛': (True, False, True, False),
        '┣': (True, True, False, True),
        '┫': (True, True, True, False),
        '┳': (False, True, True, True),
        '┻': (True, False, True, True),
        '╋': (True, True, True, True),
        # 双边框 (DOUBLE)
        '═': (False, False, True, True),
        '║': (True, True, False, False),
        '╔': (False, True, False, True),
        '╗': (False, True, True, False),
        '╚': (True, False, False, True),
        '╝': (True, False, True, False),
        '╠': (True, True, False, True),
        '╣': (True, True, True, False),
        '╦': (False, True, True, True),
        '╩': (True, False, True, True),
        '╬': (True, True, True, True),
    }
    
    # 生成文本元素
    for y, line_chars in enumerate(parsed_lines):
        x_pos = 0
        for char, color, bold in line_chars:
            if char == '\n' or char == '\r':
                continue
            
            char_w = get_char_width(char)
            x = x_pos * char_width
            y_coord = y * char_height + padding_top + 14
            
            # 表格线字符用 line 元素绘制
            if char in box_chars:
                # 字符中心位置
                char_center_x = x + char_width / 2
                char_center_y = y_coord - 10
                
                # 字符边界
                char_left = x
                char_right = x + char_width
                char_top = char_center_y - char_height / 2
                char_bottom = char_center_y + char_height / 2
                
                # 圆角字符单独处理
                if char in ['╭', '╮', '╰', '╯']:
                    corner_chars.append((char, char_center_x, char_center_y, char_left, char_right, char_top, char_bottom, color))
                    x_pos += char_w
                    continue
                
                # 获取字符的连接方向
                connections = char_connections.get(char, (False, False, False, False))
                has_top, has_bottom, has_left, has_right = connections
                
                # 绘制横线
                if has_left or has_right:
                    key = round(char_center_y, 1)
                    if key not in h_lines:
                        h_lines[key] = []
                    
                    # 确定横线的起止位置
                    x1 = char_left if has_left else char_center_x
                    x2 = char_right if has_right else char_center_x
                    h_lines[key].append((x1, x2, color))
                
                # 绘制竖线
                if has_top or has_bottom:
                    key = round(char_center_x, 1)
                    if key not in v_lines:
                        v_lines[key] = []
                    
                    # 确定竖线的起止位置
                    y1 = char_top if has_top else char_center_y
                    y2 = char_bottom if has_bottom else char_center_y
                    v_lines[key].append((y1, y2, color))
            else:
                # 普通字符用 text 元素
                escaped_char = escape(char)
                bold_class = ' class="bold"' if bold else ''
                svg_parts.append(f'  <text x="{x}" y="{y_coord}" fill="{color}"{bold_class}>{escaped_char}</text>')
            
            x_pos += char_w
    
    # 绘制合并后的横线
    for y, segments in h_lines.items():
        segments.sort(key=lambda s: s[0])
        merged = []
        if segments:
            current = list(segments[0])
            for seg in segments[1:]:
                # 增加合并阈值到 1.0，避免浮点数精度问题导致的间隙
                if seg[0] <= current[1] + 1.0 and seg[2] == current[2]:
                    current[1] = max(current[1], seg[1])
                else:
                    merged.append(tuple(current))
                    current = list(seg)
            merged.append(tuple(current))
        
        for x1, x2, color in merged:
            svg_parts.append(f'  <line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{color}" stroke-width="1"/>')
    
    # 绘制合并后的竖线
    for x, segments in v_lines.items():
        segments.sort(key=lambda s: s[0])
        merged = []
        if segments:
            current = list(segments[0])
            for seg in segments[1:]:
                # 增加合并阈值到 1.0，避免浮点数精度问题导致的间隙
                if seg[0] <= current[1] + 1.0 and seg[2] == current[2]:
                    current[1] = max(current[1], seg[1])
                else:
                    merged.append(tuple(current))
                    current = list(seg)
            merged.append(tuple(current))
        
        for y1, y2, color in merged:
            svg_parts.append(f'  <line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="{color}" stroke-width="1"/>')
    
    # 绘制圆角字符
    for char, cx, cy, left, right, top, bottom, color in corner_chars:
        if char == '╭':
            path = f'M {right} {cy} Q {cx} {cy} {cx} {bottom}'
            svg_parts.append(f'  <path d="{path}" stroke="{color}" fill="none" stroke-width="1"/>')
        elif char == '╮':
            path = f'M {left} {cy} Q {cx} {cy} {cx} {bottom}'
            svg_parts.append(f'  <path d="{path}" stroke="{color}" fill="none" stroke-width="1"/>')
        elif char == '╰':
            path = f'M {cx} {top} Q {cx} {cy} {right} {cy}'
            svg_parts.append(f'  <path d="{path}" stroke="{color}" fill="none" stroke-width="1"/>')
        elif char == '╯':
            path = f'M {cx} {top} Q {cx} {cy} {left} {cy}'
            svg_parts.append(f'  <path d="{path}" stroke="{color}" fill="none" stroke-width="1"/>')
    
    svg_parts.append('</svg>')
    
    return '\n'.join(svg_parts)

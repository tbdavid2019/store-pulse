#!/usr/bin/env python3
"""
從 favicon.svg 生成 PWA 所需的各種尺寸圖標
需要安裝: pip install Pillow cairosvg
"""

try:
    from PIL import Image
    import cairosvg
    import os
    import io
except ImportError:
    print("請先安裝必要的套件: pip install Pillow cairosvg")
    exit(1)

def svg_to_png(svg_path, png_path, size):
    """將 SVG 轉換為指定尺寸的 PNG"""
    try:
        # 讀取 SVG 檔案
        with open(svg_path, 'r', encoding='utf-8') as f:
            svg_content = f.read()
        
        # 修改 SVG 的 viewBox 以符合所需尺寸
        # 將 32x32 的 viewBox 改為 size x size
        svg_content = svg_content.replace('viewBox="0 0 32 32"', f'viewBox="0 0 32 32"')
        svg_content = svg_content.replace(f'width="32" height="32"', f'width="{size}" height="{size}"')
        
        # 使用 cairosvg 轉換為 PNG
        png_data = cairosvg.svg2png(
            bytestring=svg_content.encode('utf-8'),
            output_width=size,
            output_height=size
        )
        
        # 使用 PIL 處理圖像
        img = Image.open(io.BytesIO(png_data))
        
        # 確保是 RGBA 模式
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        
        # 保存為 PNG
        img.save(png_path, 'PNG')
        return img
        
    except Exception as e:
        print(f"轉換 SVG 到 PNG 時發生錯誤: {e}")
        return None

def create_icon_from_svg(size, filename):
    """從 SVG 創建指定尺寸的圖標"""
    svg_path = 'icons/favicon.svg'
    
    if not os.path.exists(svg_path):
        print(f"找不到 SVG 檔案: {svg_path}")
        return None
    
    # 直接從 SVG 轉換
    import io
    
    try:
        # 讀取 SVG 內容
        with open(svg_path, 'r', encoding='utf-8') as f:
            svg_content = f.read()
        
        # 使用 cairosvg 轉換
        png_data = cairosvg.svg2png(
            bytestring=svg_content.encode('utf-8'),
            output_width=size,
            output_height=size
        )
        
        # 轉換為 PIL Image
        img = Image.open(io.BytesIO(png_data))
        
        # 確保是 RGBA 模式
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        
        return img
        
    except Exception as e:
        print(f"從 SVG 生成圖標時發生錯誤: {e}")
        return None

def main():
    """生成所有需要的圖標尺寸"""
    sizes = [72, 96, 128, 144, 152, 192, 384, 512]
    
    icons_dir = 'icons'
    if not os.path.exists(icons_dir):
        os.makedirs(icons_dir)
    
    for size in sizes:
        print(f"正在生成 {size}x{size} 圖標...")
        img = create_icon_from_svg(size, f'icon-{size}x{size}.png')
        if img:
            img.save(os.path.join(icons_dir, f'icon-{size}x{size}.png'), 'PNG')
    
    # 創建 favicon.ico (32x32)
    print("正在生成 favicon.ico...")
    favicon = create_icon_from_svg(32, 'favicon.ico')
    if favicon:
        favicon.save(os.path.join(icons_dir, 'favicon.ico'), 'ICO')
    
    # 創建 Apple touch icon (180x180)
    print("正在生成 Apple touch icon...")
    apple_icon = create_icon_from_svg(180, 'apple-touch-icon.png')
    if apple_icon:
        apple_icon.save(os.path.join(icons_dir, 'apple-touch-icon.png'), 'PNG')
    
    print("所有圖標已生成完成！")

if __name__ == '__main__':
    main()
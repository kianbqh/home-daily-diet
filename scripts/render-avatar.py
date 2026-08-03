from PIL import Image, ImageDraw


SIZE = 512
image = Image.new("RGBA", (SIZE, SIZE), "#F7E9D2")
draw = ImageDraw.Draw(image)

draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=112, fill="#F7E9D2")
draw.ellipse((66, 66, 446, 446), fill="#FFF8EA")

draw.polygon([(145, 260), (367, 260), (350, 345), (320, 382), (256, 399), (192, 382), (162, 345)], fill="#C96F4A")
draw.ellipse((145, 222, 367, 292), fill="#E8915E")
draw.ellipse((168, 231, 344, 279), fill="#F2B56E")

draw.polygon([(190, 255), (205, 238), (228, 230), (245, 234), (267, 247), (280, 246), (294, 231), (310, 227), (327, 236), (342, 255), (320, 267), (290, 275), (256, 279), (220, 275)], fill="#7B9947")
draw.ellipse((210, 235, 230, 255), fill="#F5D27D")
draw.ellipse((292, 241, 310, 259), fill="#F5D27D")

draw.line((151, 173, 321, 82), fill="#7A4D3A", width=14)
draw.line((180, 205, 347, 114), fill="#B8784E", width=14)

draw.ellipse((347, 117, 403, 173), fill="#E8915E")
draw.arc((362, 124, 400, 157), start=180, end=520, fill="#FFF8EA", width=7)
draw.line((388, 154, 388, 160), fill="#FFF8EA", width=7)
draw.ellipse((384, 159, 392, 167), fill="#FFF8EA")

image.save("assets/app-avatar.png")

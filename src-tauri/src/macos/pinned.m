#import <AppKit/AppKit.h>
#include <stdint.h>
#include <math.h>
typedef void (*PPPinCallback)(uint64_t, uint8_t);
@class PPPinView;
@interface PPPinPanel : NSPanel <NSWindowDelegate>
@property uint64_t pinID;
@property PPPinCallback callback;
@end
@interface PPPinView : NSView
@property NSImage *image;
@property CGFloat zoom;
@property NSInteger quarter;
@property BOOL flipH;
@property BOOL flipV;
@property NSString *feedback;
@property NSUInteger feedbackGeneration;
@property NSButton *moreButton;
@property NSButton *closeButton;
- (void)action:(uint8_t)action;
- (void)flash:(NSString *)message;
@end
static NSMutableDictionary<NSNumber *, PPPinPanel *> *panels;
static void onMain(dispatch_block_t block) {
    if (NSThread.isMainThread) block(); else dispatch_sync(dispatch_get_main_queue(), block);
}
@implementation PPPinPanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
- (void)windowWillClose:(NSNotification *)notification {
    [panels removeObjectForKey:@(self.pinID)];
    if (self.callback) self.callback(self.pinID, 255);
}
@end
@implementation PPPinView
- (BOOL)acceptsFirstResponder { return YES; }
- (NSSize)sourceSize {
    NSBitmapImageRep *rep = nil;
    for (NSImageRep *candidate in self.image.representations) {
        if ([candidate isKindOfClass:NSBitmapImageRep.class]) { rep = (id)candidate; break; }
    }
    return rep ? NSMakeSize(rep.pixelsWide, rep.pixelsHigh) : self.image.size;
}
- (void)drawRect:(NSRect)dirtyRect {
    [NSGraphicsContext saveGraphicsState];
    NSSize source = self.sourceSize;
    NSAffineTransform *transform = [NSAffineTransform transform];
    [transform translateXBy:NSMidX(self.bounds) yBy:NSMidY(self.bounds)];
    [transform rotateByDegrees:self.quarter * 90];
    [transform scaleXBy:(self.flipH ? -1 : 1) * self.zoom
                   yBy:(self.flipV ? -1 : 1) * self.zoom];
    [transform concat];
    [self.image drawInRect:NSMakeRect(-source.width/2, -source.height/2, source.width, source.height)
                 fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
    [NSGraphicsContext restoreGraphicsState];
    if (self.feedback.length) {
        NSDictionary *attrs = @{ NSFontAttributeName: [NSFont systemFontOfSize:13],
                                  NSForegroundColorAttributeName: NSColor.labelColor };
        NSSize size = [self.feedback sizeWithAttributes:attrs];
        NSRect area = NSMakeRect(8, 8, MIN(self.bounds.size.width-16, size.width+16), size.height+12);
        [NSColor.windowBackgroundColor setFill];
        [[NSBezierPath bezierPathWithRoundedRect:area xRadius:4 yRadius:4] fill];
        [self.feedback drawInRect:NSInsetRect(area, 8, 6) withAttributes:attrs];
    }
}
- (void)layout {
    [super layout];
    self.moreButton.frame = NSMakeRect(8, self.bounds.size.height-32, 56, 24);
    self.closeButton.frame = NSMakeRect(self.bounds.size.width-64, self.bounds.size.height-32, 56, 24);
}
- (void)flash:(NSString *)message {
    self.feedback = message;
    NSUInteger generation = ++self.feedbackGeneration;
    self.needsDisplay = YES;
    __weak PPPinView *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1500*NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if (weak.feedbackGeneration == generation) { weak.feedback = nil; weak.needsDisplay = YES; }
    });
}
- (void)resizeImage {
    NSSize size = self.sourceSize;
    if (self.quarter % 2) size = NSMakeSize(size.height, size.width);
    size.width = MAX(144, size.width*self.zoom);
    size.height = MAX(72, size.height*self.zoom);
    NSRect frame = self.window.frame;
    NSPoint center = NSMakePoint(NSMidX(frame), NSMidY(frame));
    frame.size = size;
    frame.origin = NSMakePoint(center.x-size.width/2, center.y-size.height/2);
    [self.window setFrame:frame display:YES];
    self.needsLayout = YES;
    self.needsDisplay = YES;
}
- (NSImage *)renderedImage {
    NSSize size = self.sourceSize;
    if (self.quarter % 2) size = NSMakeSize(size.height, size.width);
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:(NSInteger)size.width pixelsHigh:(NSInteger)size.height bitsPerSample:8
        samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace
        bytesPerRow:0 bitsPerPixel:0];
    if (!bitmap) return nil;
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
    NSAffineTransform *transform = [NSAffineTransform transform];
    [transform translateXBy:size.width/2 yBy:size.height/2];
    [transform rotateByDegrees:self.quarter*90];
    [transform scaleXBy:self.flipH ? -1 : 1 yBy:self.flipV ? -1 : 1];
    [transform concat];
    NSSize source = self.sourceSize;
    [self.image drawInRect:NSMakeRect(-source.width/2, -source.height/2, source.width, source.height)
                 fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
    [NSGraphicsContext restoreGraphicsState];
    NSImage *result = [[NSImage alloc] initWithSize:size];
    [result addRepresentation:bitmap];
    return result;
}
- (void)action:(uint8_t)action {
    PPPinPanel *panel = (id)self.window;
    switch (action) {
        case 1: self.quarter = (self.quarter+1)%4; break;
        case 2: self.flipH = !self.flipH; break;
        case 3: self.flipV = !self.flipV; break;
        case 4: self.quarter=0; self.flipH=NO; self.flipV=NO; self.zoom=1/MAX(1,self.window.backingScaleFactor); self.window.alphaValue=1; break;
        case 5: self.window.alphaValue = self.window.alphaValue <= .45 ? 1 : self.window.alphaValue-.2; break;
        case 6: {
            NSImage *result = self.renderedImage;
            if (!result) { [self flash:@"无法创建复制图片"]; return; }
            NSPasteboard *board = NSPasteboard.generalPasteboard;
            [board clearContents];
            [self flash:[board writeObjects:@[result]] ? @"图片已复制" : @"复制失败，请重试"];
            return;
        }
        case 7: self.zoom = MIN(8, self.zoom*1.1); break;
        case 8: self.zoom = MAX(.05, self.zoom/1.1); break;
        case 10: [self flash:@"正在识别文字…"]; if(panel.callback) panel.callback(panel.pinID, action); return;
        case 11: if(panel.callback) panel.callback(panel.pinID, action); return;
        case 255: [panel close]; return;
        default: return;
    }
    [self resizeImage];
    [self flash:[NSString stringWithFormat:@"%.0f%% · %ld° · 透明度 %.0f%%", self.zoom*100,
                 (long)self.quarter*90, panel.alphaValue*100]];
}
- (void)menuAction:(NSMenuItem *)item { [self action:(uint8_t)item.tag]; }
- (NSMenu *)imageMenu {
    NSMenu *menu = [NSMenu new];
    NSArray *titles = @[@"旋转 90°", @"水平翻转", @"垂直翻转", @"恢复原样", @"调整透明度",
                       @"复制图片", @"放大", @"缩小", @"复制文字（OCR）", @"重新编辑", @"关闭贴图"];
    NSArray *actions = @[@1,@2,@3,@4,@5,@6,@7,@8,@10,@11,@255];
    for (NSUInteger i=0; i<titles.count; i++) {
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:titles[i] action:@selector(menuAction:) keyEquivalent:@""];
        item.target=self; item.tag=[actions[i] integerValue]; [menu addItem:item];
    }
    return menu;
}
- (void)more:(id)sender { [self.imageMenu popUpMenuPositioningItem:nil atLocation:NSMakePoint(8, self.bounds.size.height-32) inView:self]; }
- (void)closeImage:(id)sender { [self action:255]; }
- (void)rightMouseDown:(NSEvent *)event { [NSMenu popUpContextMenu:self.imageMenu withEvent:event forView:self]; }
- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
    if (event.clickCount==2) [self action:11]; else [self.window performWindowDragWithEvent:event];
}
- (void)scrollWheel:(NSEvent *)event {
    if (event.scrollingDeltaY==0) return;
    self.zoom = MIN(8, MAX(.05, self.zoom*exp(event.scrollingDeltaY*.015)));
    [self resizeImage]; [self flash:[NSString stringWithFormat:@"缩放 %.0f%%", self.zoom*100]];
}
- (void)keyDown:(NSEvent *)event {
    NSString *key = event.charactersIgnoringModifiers.lowercaseString;
    if (event.keyCode==53) [self action:255];
    else if ([key isEqual:@"c"] && (event.modifierFlags & NSEventModifierFlagCommand)) [self action:6];
    else if ([key isEqual:@"r"]) [self action:1];
    else if ([key isEqual:@"f"]) [self action:2];
    else if ([key isEqual:@"t"]) [self action:5];
    else if ([key isEqual:@"0"]) [self action:4];
    else [super keyDown:event];
}
@end
int32_t pp_pin_open(uint64_t pinID, const char *path, PPPinCallback callback) {
    if (!path || !callback) return 1;
    NSString *file = [NSString stringWithUTF8String:path];
    __block int32_t result = 0;
    onMain(^{ @autoreleasepool {
        NSImage *image = [[NSImage alloc] initWithContentsOfFile:file];
        if (!image || image.size.width<=0 || image.size.height<=0) { result=2; return; }
        if (!panels) panels=[NSMutableDictionary new];
        PPPinPanel *panel = [[PPPinPanel alloc] initWithContentRect:NSMakeRect(0,0,300,200)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        panel.pinID=pinID; panel.callback=callback; panel.delegate=panel;
        panel.level=NSFloatingWindowLevel; panel.releasedWhenClosed=NO;
        panel.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        panel.opaque=NO; panel.backgroundColor=NSColor.clearColor; panel.hasShadow=YES;
        PPPinView *view = [PPPinView new]; view.image=image; view.zoom=1;
        NSRect screen = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).visibleFrame;
        CGFloat backing = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).backingScaleFactor;
        NSSize size=view.sourceSize;
        // One source pixel per display pixel at initial placement, including Retina.
        view.zoom=MIN(1/MAX(1,backing), MIN(screen.size.width*.85/size.width, screen.size.height*.85/size.height));
        panel.contentView=view;
        view.moreButton=[NSButton buttonWithTitle:@"更多" target:view action:@selector(more:)];
        view.closeButton=[NSButton buttonWithTitle:@"关闭" target:view action:@selector(closeImage:)];
        [view addSubview:view.moreButton]; [view addSubview:view.closeButton];
        panels[@(pinID)]=panel;
        [view resizeImage]; [panel center]; [panel makeKeyAndOrderFront:nil]; [panel makeFirstResponder:view];
    }});
    return result;
}
void pp_pin_action(uint64_t pinID, uint8_t action) {
    dispatch_async(dispatch_get_main_queue(), ^{ [(PPPinView *)panels[@(pinID)].contentView action:action]; });
}
void pp_pin_feedback(uint64_t pinID, const char *message) {
    NSString *text=[NSString stringWithUTF8String:message ?: ""];
    dispatch_async(dispatch_get_main_queue(), ^{ [(PPPinView *)panels[@(pinID)].contentView flash:text]; });
}

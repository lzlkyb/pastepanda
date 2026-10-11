#import <CoreVideo/CoreVideo.h>
#include "../screenshot_legacy.m"
#include <assert.h>
double pp_mac_screen_scale(void){return 1;}
int main(){@autoreleasepool{
    CVPixelBufferRef pixels=NULL;assert(CVPixelBufferCreate(NULL,16,8,kCVPixelFormatType_32BGRA,NULL,&pixels)==0);
    CVPixelBufferLockBaseAddress(pixels,0);uint8_t *base=CVPixelBufferGetBaseAddress(pixels);size_t stride=CVPixelBufferGetBytesPerRow(pixels);
    for(size_t y=0;y<8;y++)for(size_t x=0;x<16;x++){uint8_t *p=base+y*stride+x*4;p[0]=70;p[1]=20;p[2]=200;p[3]=255;}
    CVPixelBufferUnlockBaseAddress(pixels,0);
    NSData *png=snapshotPNG(pixels);assert(png.length>0);NSBitmapImageRep *image=[[NSBitmapImageRep alloc] initWithData:png];assert(image.pixelsWide==16 && image.pixelsHigh==8);
    NSColor *color=[[image colorAtX:8 y:4] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];assert(color.redComponent>.7 && color.greenComponent<.2 && color.blueComponent<.4);
    assert(!snapshotPNG(NULL));CVPixelBufferRelease(pixels);
    assert(CVPixelBufferCreate(NULL,16,8,kCVPixelFormatType_32ARGB,NULL,&pixels)==0);assert(!snapshotPNG(pixels));CVPixelBufferRelease(pixels);
    puts("PASS: legacy screenshot BGRA converts to owned PNG with valid dimensions/colors; unsupported formats rejected (fixture, no screen capture)");
}return 0;}

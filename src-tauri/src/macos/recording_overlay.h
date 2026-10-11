#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
@interface PPClickPainter : NSObject
@property(readonly) BOOL backpressured;
// Owned copy; source pixels and timing remain untouched. BGRA capture only.
- (CMSampleBufferRef)copySample:(CMSampleBufferRef)sample x:(double)x y:(double)y radius:(double)radius age:(double)age CF_RETURNS_RETAINED;
@end

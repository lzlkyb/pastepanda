#import <AVFoundation/AVFoundation.h>
#include <stdlib.h>
int32_t pp_trim_index(const char *path,uint8_t **bytes,size_t *length) {
    if(!path || !bytes || !length) return 1; *bytes=NULL;*length=0;
    @autoreleasepool {
        AVURLAsset *asset=[AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(path)] options:nil];
        AVAssetTrack *track=[asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        double duration=CMTimeGetSeconds(CMTimeRangeGetEnd(track.timeRange));
        if(!track || !isfinite(duration) || duration<=0 || duration>86400) return 2;
        NSError *error=nil; AVAssetReader *reader=[[AVAssetReader alloc] initWithAsset:asset error:&error];
        AVAssetReaderTrackOutput *output=[AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:track outputSettings:nil];
        output.alwaysCopiesSampleData=NO;
        if(!reader || ![reader canAddOutput:output]) return 2;
        [reader addOutput:output]; if(![reader startReading]) return 2;
        NSMutableSet<NSNumber *> *keys=[NSMutableSet new]; CMSampleBufferRef sample;
        NSUInteger total=0;
        while((sample=[output copyNextSampleBuffer])) {
            CMItemCount count=CMSampleBufferGetNumSamples(sample);
            NSArray *attachments=(__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample,false);
            for(CMItemCount i=0;i<count;i++) {
                CMSampleTimingInfo timing;
                if(CMSampleBufferGetSampleTimingInfo(sample,i,&timing)!=noErr) { CFRelease(sample); [reader cancelReading]; return 2; }
                NSDictionary *flags=i<(CMItemCount)attachments.count ? attachments[i] : nil;
                double pts=CMTimeGetSeconds(timing.presentationTimeStamp);
                if(![flags[(__bridge NSString *)kCMSampleAttachmentKey_NotSync] boolValue] && isfinite(pts) && pts>=0 && pts<duration)
                    [keys addObject:@((uint64_t)llround(pts*1000))];
            }
            total+=(NSUInteger)MAX(0,count); CFRelease(sample);
            if(total>6000000 || keys.count>100000) { [reader cancelReading]; return 3; }
        }
        if(reader.status!=AVAssetReaderStatusCompleted || total==0 || keys.count==0) return 2;
        // The endpoint is a valid cut boundary, even for a one-keyframe short clip.
        uint64_t milliseconds=(uint64_t)llround(duration*1000); [keys addObject:@(milliseconds)];
        NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"durationMs":@(milliseconds),@"assetDurationMs":@((uint64_t)llround(CMTimeGetSeconds(asset.duration)*1000)),@"keyframesMs":[keys.allObjects sortedArrayUsingSelector:@selector(compare:)]} options:0 error:nil];
        if(!json || json.length>4*1024*1024) return 3;
        *bytes=malloc(json.length); if(!*bytes) return 3;
        memcpy(*bytes,json.bytes,json.length);*length=json.length;return 0;
    }
}
int32_t pp_trim_export(const char *source,const char *destination,uint64_t begin,uint64_t end) {
    if(!source || !destination || begin>=end || end>86400000) return 1;
    @autoreleasepool {
        NSString *target=@(destination);
        if([NSFileManager.defaultManager fileExistsAtPath:target]) return 4;
        AVURLAsset *asset=[AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(source)] options:nil];
        AVAssetExportSession *export=[[AVAssetExportSession alloc] initWithAsset:asset presetName:AVAssetExportPresetPassthrough];
        if(!export || ![export.supportedFileTypes containsObject:AVFileTypeMPEG4]) return 2;
        export.outputURL=[NSURL fileURLWithPath:target];export.outputFileType=AVFileTypeMPEG4;
        export.timeRange=CMTimeRangeFromTimeToTime(CMTimeMake(begin,1000),CMTimeMake(end,1000));
        dispatch_semaphore_t done=dispatch_semaphore_create(0);
        [export exportAsynchronouslyWithCompletionHandler:^{dispatch_semaphore_signal(done);}];
        if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC))!=0) {
            [export cancelExport];return 5;
        }
        if(export.status!=AVAssetExportSessionStatusCompleted) return 2;
        AVURLAsset *result=[AVURLAsset URLAssetWithURL:export.outputURL options:nil];
        if([result tracksWithMediaType:AVMediaTypeVideo].count==0) return 6;
        return 0;
    }
}

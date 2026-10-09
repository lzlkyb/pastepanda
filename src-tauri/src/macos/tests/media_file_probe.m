// Read-only acceptance probe for an existing recording; no capture or playback.
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#include <math.h>

int main(int argc,const char **argv){@autoreleasepool{
    if(argc!=2){fprintf(stderr,"Usage: media_file_probe recording.mp4\n");return 2;}
    NSURL *url=[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    AVURLAsset *asset=[AVURLAsset URLAssetWithURL:url options:nil];
    double duration=CMTimeGetSeconds(asset.duration);if(!isfinite(duration) || duration<=0){fprintf(stderr,"Invalid asset duration: %f\n",duration);return 2;}
    NSMutableArray *tracks=[NSMutableArray new];BOOL videoOK=NO;
    for(AVAssetTrack *track in asset.tracks){
        if(![track.mediaType isEqual:AVMediaTypeVideo] && ![track.mediaType isEqual:AVMediaTypeAudio])continue;
        NSError *error=nil;AVAssetReader *reader=[[AVAssetReader alloc] initWithAsset:asset error:&error];
        AVAssetReaderTrackOutput *output=[[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:nil];
        if(!reader || ![reader canAddOutput:output]){fprintf(stderr,"Cannot create track reader: %s, %ld\n",track.mediaType.UTF8String,(long)error.code);return 2;}
        [reader addOutput:output];if(![reader startReading]){fprintf(stderr,"Cannot start reader: %s, %ld\n",track.mediaType.UTF8String,(long)reader.error.code);return 2;}
        NSUInteger count=0,emptyBuffers=0;double first=NAN,last=0,end=0,gap=0,previous=-1;
        for(;;){CMSampleBufferRef sample=[output copyNextSampleBuffer];if(!sample)break;
            // AVAssetReader can emit buffers without media samples; report them,
            // but only media-bearing buffers contribute to timestamp checks.
            if(CMSampleBufferIsValid(sample) && CMSampleBufferGetNumSamples(sample)==0 && CMSampleBufferGetTotalSampleSize(sample)==0){emptyBuffers++;CFRelease(sample);continue;}
            double at=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
            double span=CMTimeGetSeconds(CMSampleBufferGetDuration(sample));
            if(!isfinite(at)){fprintf(stderr,"Invalid presentation timestamp: %s, sample %lu, flags %u, sample count %ld, bytes %lu\n",track.mediaType.UTF8String,(unsigned long)count,CMSampleBufferGetPresentationTimeStamp(sample).flags,(long)CMSampleBufferGetNumSamples(sample),(unsigned long)CMSampleBufferGetTotalSampleSize(sample));CFRelease(sample);return 2;}
            if(!count)first=at;if(previous>=0)gap=fmax(gap,at-previous);previous=at;
            last=fmax(last,at);end=fmax(end,at+(isfinite(span)?span:0));count++;
            CFRelease(sample);
        }
        if(reader.status!=AVAssetReaderStatusCompleted || !count){fprintf(stderr,"Track not complete: %s, samples %lu, status %ld, error %ld\n",track.mediaType.UTF8String,(unsigned long)count,(long)reader.status,(long)reader.error.code);return 2;}
        BOOL video=[track.mediaType isEqual:AVMediaTypeVideo];
        if(video)videoOK=last>=duration-.25;
        [tracks addObject:@{ @"kind":video?@"video":@"audio",@"sampleBuffers":@(count),@"emptyBuffers":@(emptyBuffers),@"firstSeconds":@(first),@"lastSeconds":@(last),@"endSeconds":@(end),@"maxGapSeconds":@(gap),@"width":@(video?track.naturalSize.width:0),@"height":@(video?track.naturalSize.height:0)}];
    }
    NSDictionary *result=@{@"durationSeconds":@(duration),@"tracks":tracks,@"videoReachesTail":@(videoOK)};
    NSData *json=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
    fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);return videoOK?0:1;
}}

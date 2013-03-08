define([
           'dojo/_base/declare',
           'dojo/_base/array',
           'dojo/_base/Deferred',
           'JBrowse/Store/SeqFeature',
           'JBrowse/Store/DeferredStatsMixin',
           'JBrowse/Store/DeferredFeaturesMixin',
           'JBrowse/Store/TabixIndexedFile',
           'JBrowse/Model/SimpleFeature',
           'JBrowse/Store/SeqFeature/GlobalStatsEstimationMixin',
           'JBrowse/Model/XHRBlob',
           'JBrowse/Digest/Crc32'
       ],
       function(
           declare,
           array,
           Deferred,
           SeqFeatureStore,
           DeferredStatsMixin,
           DeferredFeaturesMixin,
           TabixIndexedFile,
           SimpleFeature,
           GlobalStatsEstimationMixin,
           XHRBlob,
           Digest
       ) {


// subclass the TabixIndexedFile to modify the parsed items a little
// bit so that the range filtering in TabixIndexedFile will work.  VCF
// files don't actually have an end coordinate, so we have to make it
// here.  also convert coordinates to interbase.
var VCFIndexedFile = declare( TabixIndexedFile, {
    parseItem: function() {
        var i = this.inherited( arguments );
        if( i ) {
            i.start--;
            i.end = i.start + i.fields[3].length;
        }
        return i;
    }
});

return declare( [SeqFeatureStore,DeferredStatsMixin,DeferredFeaturesMixin,GlobalStatsEstimationMixin],
{

    constructor: function( args ) {
        var thisB = this;

        var tbiBlob = args.tbiBlob ||
            new XHRBlob( this.resolveUrl(
                             this.getConf('tbiUrlTemplate',[]) || this.getConf('urlTemplate',[])+'.tbi',
                             {'refseq': (this.refSeq||{}).name }
                         )
                       );

        var fileBlob = args.fileBlob ||
            new XHRBlob( this.resolveUrl( this.getConf('urlTemplate',[]),
                             {'refseq': (this.refSeq||{}).name }
                           )
                       );

        this.indexedData = new VCFIndexedFile({ tbi: tbiBlob, file: fileBlob });

        this._loadHeader().then( function() {
            thisB._estimateGlobalStats( function( stats, error ) {
                if( error )
                    thisB._failAllDeferred( error );
                else {
                    thisB.globalStats = stats;
                    thisB._deferred.stats.resolve({success:true});
                    thisB._deferred.features.resolve({success:true});
                }
            });
        });
    },

    /** fetch and parse the VCF header lines */
    _loadHeader: function() {
        var thisB = this;
        return this._parsedHeader = this._parsedHeader || function() {
            var d = new Deferred();

            thisB.indexedData.indexLoaded.then( function() {
                var maxFetch = thisB.indexedData.index.firstDataLine
                    ? thisB.indexedData.index.firstDataLine.block + thisB.indexedData.data.blockSize - 1
                    : null;

                thisB.indexedData.data.read(
                    0,
                    maxFetch,
                    function( bytes ) {

                        thisB.header = thisB._parseHeader( new Uint8Array( bytes ) );

                        d.resolve({ success:true});
                    },
                    dojo.hitch( d, 'reject' )
                );
            });

            return d;
        }.call();
    },

    _newlineCode: "\n".charCodeAt(0),

    /**
     *  helper method that parses the next line from a Uint8Array or similar.
     *  @param parseState.data the byte array
     *  @param parseState.offset the offset to start parsing.  <THIS VALUE IS MODIFIED BY THIS METHOD.
     */
    _getlineFromBytes: function( parseState ) {
        if( ! parseState.offset )
            parseState.offset = 0;

        var newlineIndex = array.indexOf( parseState.data, this._newlineCode, parseState.offset );

        if( newlineIndex == -1 ) // no more lines
            return null;

        var line = String.fromCharCode.apply( String, Array.prototype.slice.call( parseState.data, parseState.offset, newlineIndex ));
        parseState.offset = newlineIndex+1;
        return line;
    },

    /**
     * Parse the bytes that contain the VCF header, returning an
     * object containing the parsed data.
     */
    _parseHeader: function( headerBytes ) {

        // parse the header lines
        var headData = {};
        var parseState = { data: headerBytes, offset: 0 };
        var line;
        while(( line = this._getlineFromBytes( parseState ))) {
            var match = /^##([^\s#=]+)=(.+)/.exec( line);
            if( ! match || !match[1] )
                continue;

            var metaField = match[1].toLowerCase();
            var metaData = (match[2]||'');

            // TODO: do further parsing for some fields
            if( metaField == 'info' ) {
                metaData = this._parseInfoHeaderLine( metaData );
            }
            else if( metaField == 'format' ) {
                metaData = this._parseFormatHeaderLine( metaData );
            }
            else if( metaField == 'filter' ) {
                metaData = this._parseFilterHeaderLine( metaData );
            }

            if( ! headData[metaField] )
                headData[metaField] = [];

            headData[metaField].push( metaData );
        }
        //console.log(headData);
        return headData;
    },

    _parseInfoHeaderLine: function( metaData ) {
        var match = /^<\s*ID\s*=\s*([^,]*),\s*Number\s*=\s*([^,]*),\s*Type\s*=\s*([^,]*),\s*Description\s*=\s*"([^"]*)"/i.exec( metaData );
        if( match ) {
            return {
                id: match[1],
                number: match[2],
                type: match[3],
                description: match[4]
            };
        }
        return metaData;
    },
    _parseFormatHeaderLine: function( metaData ) {
        return this._parseInfoHeaderLine( metaData );
    },
    _parseFilterHeaderLine: function( metaData ) {
        var match = /^<\s*ID\s*=\s*([^,]*),\s*Description\s*=\s*"([^"]*)"/i.exec( metaData );
        if( match ) {
            return {
                id: match[1],
                description: match[2]
            };
        }
        return metaData;
    },

    _lineToFeature: function( line ) {
        var fields = line.fields;
        for( var i=0; i<fields.length; i++ )
            if( fields[i] == '.' )
                fields[i] = null;

        var ref = fields[3];
        var alt = fields[4];
        var SO_type = this._so_type( ref, alt );
        var featureData = {
            start:  line.start,
            end:    line.start+ref.length,
            seq_id: line.ref,
            description: SO_type+": "+ref+" -> "+alt,
            name:   fields[2],
            type:   SO_type,
            ref:    ref,
            alternative_alleles:    alt,
            score:   fields[5],
            filter: fields[6],
            info:   fields[7],
            format: fields[8],
            other:  fields.slice( 9 )
        };
        var f = new SimpleFeature({
            id: fields[2] || Digest.objectFingerprint( fields.slice( 0, 9 ) ),
            data: featureData
        });
        return f;
    },

    _so_type: function( ref, alt ) {
        // it's just a remark if there are no alternate alleles
        if( alt == '.' )
            return 'remark';

        alt = (alt||'.').split(',');
        var minAltLen = Infinity;
        var maxAltLen = -Infinity;
        var altLen = array.map( alt, function(a) {
            var l = a.length;
            if( l < minAltLen )
                minAltLen = l;
            if( l > maxAltLen )
                maxAltLen = l;
            return a.length;
        });

        if( ref.length == 1 && minAltLen == 1 && maxAltLen == 1 )
            return 'SNV'; // use SNV because SO definition of SNP says
                          // abundance must be at least 1% in
                          // population, and can't be sure we meet
                          // that

        if( ref.length == minAltLen && ref.length == maxAltLen )
            if( alt.length == 1 && ref.split('').reverse().join('') == alt[0] )
                return 'inversion';
            else
                return 'substitution';

        if( ref.length == minAltLen && ref.length < maxAltLen )
            return 'insertion';

        if( ref.length > minAltLen && ref.length == maxAltLen )
            return 'deletion';

        return 'indel';
    },

    _getFeatures: function( query, featureCallback, finishedCallback, errorCallback ) {
        var thisB = this;
        thisB._loadHeader().then( function() {
            thisB.indexedData.getLines(
                query.ref || thisB.refSeq.name,
                query.start,
                query.end,
                function( line ) {
                    var f = thisB._lineToFeature( line );
                    //console.log(f);
                    featureCallback( f );
                    //return f;
                },
                finishedCallback,
                errorCallback
            );
        });
    },

    getRefSeqs: function( refSeqCallback, finishedCallback, errorCallback ) {
        return this.indexedData.index.getRefSeqs.apply( this.indexedData.index, arguments );
    }

});
});
function InitTagValue()
{
/*
  Acquire Downstream Channel (text) | Acquire Downstream Channel Comment (text) |
  Connectivity State (text) | Connectivity State Comment (text) |
  Boot State (text) | Boot State Comment (text) |
  Configuration File (text) | Configuration File Comment (text) |
  Security (text) | Security Comment (text) |
  Current System Time (text)
*/
    var tagValueList = {"AcquireDsChanelComment":"Locked","AcquireDsChanelStatus":"657","Startupfreq":"657000000","ConnectivityStateStatus":"OK","BootStateStatus":"OK","ConnectivityStateComment":"Operational","BootStateComment":"Operational","ConfigurationFileStatus":"&nbsp;","ConfigurationFileComment":"&nbsp;","SecurityStatus":"Enabled","SecurityComment":"BPI+","CurrentSystemTime":"Wed Aug 05 01:29:43 2026","DownstreamBondedChannels":"0","UpstreamBondedChannels":"0","ExtendedUsTxPower":"2","SystemUpTime":"02:51:08"};

    return tagValueList;
}

function InitUsTableTagValue()
{
/*
  Channel (text) | Lock Status (text) | US Channel Type (text) | Channel ID (text) | Symbol Rate (text) | Frequency (text) | Power (text)
*/
/*
    var tagValueList = "4" +
        "|1|Not Locked|Unknown|0|0|0|0.0" +
        "|2|Not Locked|Unknown|0|0|0|0.0" +
        "|3|Not Locked|Unknown|0|0|0|0.0" +
        "|4|Not Locked|Unknown|0|0|0|0.0";
*/
    var tagValueList = "8|1|Locked|ATDMA|1|5120 Ksym/sec|17600000 Hz|41.3 dBmV|2|Locked|ATDMA|2|5120 Ksym/sec|24000000 Hz|41.5 dBmV|3|Locked|ATDMA|3|5120 Ksym/sec|30400000 Hz|41.5 dBmV|4|Locked|ATDMA|4|5120 Ksym/sec|36800000 Hz|41.8 dBmV|5|Not Locked|Unknown|0|0|0|0.0|6|Not Locked|Unknown|0|0|0|0.0|7|Not Locked|Unknown|0|0|0|0.0|8|Not Locked|Unknown|0|0|0|0.0|";

    return tagValueList.split("|");
}

function onAddUsRowCB(newRow, rowId, firstCellIdx, tags)
{
    for (i =0; i < tags.length; i++)
    {
        if (tags[i] == "Apply")
            tags[i] = vApply;
        else if (tags[i] == "Cancel")
            tags[i] = vCancel;
        else if (tags[i] == "Locked")
            tags[i] = vLocked;
        else if (tags[i] == "Operational")
            tags[i] = vOperational;
        else if (tags[i] == "Disabled")
            tags[i] = vDisabled;
        else if (tags[i] == "Not Locked")
            tags[i] = vNotLockedl;
        else if (tags[i] == "Unknown")
            tags[i] = vUnknown;
    }
    var cellsArray = new Array();

    cellsArray [0] = tags[firstCellIdx + 0];
    cellsArray [1] = tags[firstCellIdx + 1];
    cellsArray [2] = tags[firstCellIdx + 2];
    cellsArray [3] = tags[firstCellIdx + 3];
    cellsArray [4] = tags[firstCellIdx + 4];
    cellsArray [5] = tags[firstCellIdx + 5];
    var us_power = parseFloat(tags[firstCellIdx + 6]);
    cellsArray [6] = us_power.toFixed(1) + " dBmV";

    return cellsArray;
}

function InitDsTableTagValue()
{
/*
  Channel (text) | Lock Status (text) | Modulation (text) | Channel ID (text) | Frequency (text) | Power (text) | SNR (text) | Correctables (text) | Uncorrectables (text)
*/
/*
    var tagValueList = "8" +
        "|1|Locked|Unknown|0|809500000|-61.6|0.0|11|0" +
        "|2|Not Locked|Unknown|0|0|0.0|0.0|0|0" +
        "|3|Not Locked|Unknown|0|0|0.0|0.0|0|0" +
        "|4|Not Locked|Unknown|0|0|0.0|0.0|0|0" +
        "|5|Not Locked|Unknown|0|0|0.0|0.0|0|0" +
        "|6|Not Locked|Unknown|0|0|0.0|0.0|0|0" +
        "|7|Not Locked|Unknown|0|0|0.0|0.0|0|0" +
        "|8|Not Locked|Unknown|0|0|0.0|0.0|0|0";
*/
    var tagValueList = "32|1|Locked|256 QAM|22|657000000 Hz|-2.2 dBmV|41.8 dB|3|0|2|Locked|256 QAM|1|531000000 Hz|-3 dBmV|41.8 dB|2|0|3|Locked|256 QAM|2|537000000 Hz|-3 dBmV|41.4 dB|2|0|4|Locked|256 QAM|3|543000000 Hz|-3.3 dBmV|41.6 dB|1|0|5|Locked|256 QAM|4|549000000 Hz|-3.6 dBmV|41.3 dB|3|0|6|Locked|256 QAM|5|555000000 Hz|-3.8 dBmV|41.2 dB|3|0|7|Locked|256 QAM|6|561000000 Hz|-3.8 dBmV|40.5 dB|1|0|8|Locked|256 QAM|7|567000000 Hz|-3.8 dBmV|41.2 dB|3|0|9|Locked|256 QAM|8|573000000 Hz|-3.4 dBmV|41.5 dB|2|0|10|Locked|256 QAM|9|579000000 Hz|-3.1 dBmV|41.3 dB|3|0|11|Locked|256 QAM|10|585000000 Hz|-2.6 dBmV|41.8 dB|3|0|12|Locked|256 QAM|11|591000000 Hz|-2.1 dBmV|41.6 dB|3|0|13|Locked|256 QAM|12|597000000 Hz|-2 dBmV|41.8 dB|3|0|14|Locked|256 QAM|13|603000000 Hz|-1.9 dBmV|42 dB|1|0|15|Locked|256 QAM|14|609000000 Hz|-2.2 dBmV|41.5 dB|2|0|16|Locked|256 QAM|15|615000000 Hz|-2.4 dBmV|41.9 dB|2|0|17|Locked|256 QAM|16|621000000 Hz|-2.5 dBmV|41.4 dB|6|0|18|Locked|256 QAM|17|627000000 Hz|-2.3 dBmV|41.6 dB|3|0|19|Locked|256 QAM|18|633000000 Hz|-2.7 dBmV|41.4 dB|4|0|20|Locked|256 QAM|19|639000000 Hz|-2.7 dBmV|41.3 dB|4|0|21|Locked|256 QAM|20|645000000 Hz|-2.6 dBmV|41.6 dB|1|0|22|Locked|256 QAM|21|651000000 Hz|-2.5 dBmV|41.4 dB|2|0|23|Locked|256 QAM|23|663000000 Hz|-1.9 dBmV|41.7 dB|3|0|24|Locked|256 QAM|24|669000000 Hz|-1.7 dBmV|41.8 dB|4|0|25|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|26|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|27|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|28|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|29|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|30|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|31|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|32|Not Locked|Unknown|0|0 Hz|0.0|0.0|0|0|";

    return tagValueList.split("|");
}

function onAddDsRowCB(newRow, rowId, firstCellIdx, tags)
{
    for (i =0; i < tags.length; i++)
    {
        if (tags[i] == "Apply")
            tags[i] = vApply;
        else if (tags[i] == "Cancel")
            tags[i] = vCancel;
        else if (tags[i] == "Locked")
            tags[i] = vLocked;
        else if (tags[i] == "Operational")
            tags[i] = vOperational;
        else if (tags[i] == "Disabled")
            tags[i] = vDisabled;
        else if (tags[i] == "Not Locked")
            tags[i] = vNotLockedl;
        else if (tags[i] == "Unknown")
            tags[i] = vUnknown;
    }
    var cellsArray = new Array();

    cellsArray [0] = tags[firstCellIdx + 0];
    cellsArray [1] = tags[firstCellIdx + 1];
    cellsArray [2] = tags[firstCellIdx + 2];
    cellsArray [3] = tags[firstCellIdx + 3];
    cellsArray [4] = tags[firstCellIdx + 4];
    var ds_power = parseFloat(tags[firstCellIdx + 5]);
    cellsArray [5] = ds_power.toFixed(1) + " dBmV";
    var ds_snr = parseFloat(tags[firstCellIdx + 6]);
    cellsArray [6] = ds_snr.toFixed(1) + " dB";
    cellsArray [7] = tags[firstCellIdx + 7];
    cellsArray [8] = tags[firstCellIdx + 8];

    return cellsArray;
}

function InitUsTableUpdateView(tagValues)
{
    /* draw table and insert content value */
    drawTable('usTable', tagValues, onAddUsRowCB);
}

function InitDsTableUpdateView(tagValues)
{
    /* draw table and insert content value */
    drawTable('dsTable', tagValues, onAddDsRowCB);
}

function InitUsOfdmaTableTagValue()
{
    /*
    var tagValueList = '2'
        + '|1||Success|1300000 Hz|74~1673|18|30.8 dBmV'
        + '|2||Success|41300000 Hz|74~1673|18|30.5 dBmV';
    */
    var tagValueList = "2|1|Not Locked|0|0|0 Hz|0 dBmV|2|Not Locked|0|0|0 Hz|0 dBmV";

    return tagValueList.split("|");
}

function onAddUsOfdmaRowCB(newRow, rowId, firstCellIdx, tags)
{
    var cellsArray = new Array();

    cellsArray [0] = tags[firstCellIdx + 0];
    cellsArray [1] = tags[firstCellIdx + 1];
    cellsArray [2] = tags[firstCellIdx + 2];
    cellsArray [3] = tags[firstCellIdx + 3];
    cellsArray [4] = tags[firstCellIdx + 4];
    cellsArray [5] = tags[firstCellIdx + 5];

    return cellsArray;
}

function InitUsOfdmaTableUpdateView(tagValues)
{
    drawTable('usOfdmaTable', tagValues, onAddUsOfdmaRowCB);
}

function InitDsOfdmTableTagValue()
{
    /*
    var tagValueList = '2'
        + '|1|66|Primary|297600000 Hz|148~3947|0|0'
        + '|2|99|Backup Primary|495600000 Hz|148~3947|0|0';
    */
    var tagValueList = "2|1|Locked|0 ,1 ,2 ,3|25|516000000 Hz|-2.92 dBmV|41.8 dB|208 ~ 3887|185404237|167393611|0|2|Not Locked|0|0|0 Hz|0 dBmV|0 dB|0 ~ 4095|0|0|0|";

    return tagValueList.split("|");
}
